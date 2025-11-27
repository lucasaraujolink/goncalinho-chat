import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import multer from 'multer';
import { fileURLToPath } from 'url';
import { GoogleGenAI } from '@google/genai';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const pdf = require('pdf-parse');
const mammoth = require('mammoth');
const xlsx = require('xlsx');
const { parse } = require('csv-parse/sync');

// --- CONFIGURATION ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = process.env.PORT || 3001;

// Persistence Paths
const VPS_DATA_PATH = '/var/www/goncalinho_data';
const LOCAL_DATA_PATH = path.join(__dirname, 'data_storage');
// Check if we have write access to VPS path, otherwise fallback
let DATA_DIR = LOCAL_DATA_PATH;
try {
  if (fs.existsSync('/var/www')) {
    // Try to write a test file
    fs.accessSync('/var/www', fs.constants.W_OK);
    DATA_DIR = VPS_DATA_PATH;
  }
} catch (e) {
  console.log("Using local storage path due to permissions or missing directory.");
}

const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const CHUNKS_FILE = path.join(DATA_DIR, 'chunks.json');

// Ensure directories exist
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// --- MIDDLEWARE ---
const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({ 
  dest: UPLOAD_DIR,
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB limit
});

// --- DATABASE HELPERS ---
const readJson = (file, defaultVal) => {
  try {
    if (!fs.existsSync(file)) return defaultVal;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.error(`Error reading ${file}:`, e);
    return defaultVal;
  }
};

const writeJson = (file, data) => {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.error(`Error writing ${file}:`, e);
  }
};

// --- FILE PARSING & CHUNKING ---
const processFile = async (filePath, originalName, mimeType) => {
  const ext = path.extname(originalName).toLowerCase();
  let chunks = [];

  try {
    if (ext === '.pdf') {
      const dataBuffer = fs.readFileSync(filePath);
      const data = await pdf(dataBuffer);
      // Chunk by paragraphs approx 1000 chars
      chunks = chunkText(data.text, 1000);
    } else if (ext === '.docx') {
      const result = await mammoth.extractRawText({ path: filePath });
      chunks = chunkText(result.value, 1500);
    } else if (ext === '.csv') {
      const fileContent = fs.readFileSync(filePath, 'utf8');
      const records = parse(fileContent, { columns: true, skip_empty_lines: true });
      chunks = chunkTable(records, 50); // 50 rows per chunk
    } else if (ext === '.xlsx' || ext === '.xls') {
      const workbook = xlsx.readFile(filePath);
      let allRecords = [];
      workbook.SheetNames.forEach(sheetName => {
        const rows = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName]);
        const rowsWithContext = rows.map(r => ({ _sheet: sheetName, ...r }));
        allRecords = allRecords.concat(rowsWithContext);
      });
      chunks = chunkTable(allRecords, 50);
    } else if (ext === '.txt') {
      const text = fs.readFileSync(filePath, 'utf8');
      chunks = chunkText(text, 1000);
    }
  } catch (err) {
    console.error("Processing error:", err);
    throw err;
  } finally {
    try { fs.unlinkSync(filePath); } catch(e) {}
  }

  return chunks;
};

const chunkText = (text, targetSize) => {
  const chunks = [];
  // Split by double newline to preserve paragraphs
  const paragraphs = text.split(/\n\s*\n/);
  let currentChunk = '';

  for (const para of paragraphs) {
    if ((currentChunk + para).length > targetSize && currentChunk.length > 0) {
      chunks.push(currentChunk.trim());
      currentChunk = para;
    } else {
      currentChunk += (currentChunk ? '\n\n' : '') + para;
    }
  }
  if (currentChunk) chunks.push(currentChunk.trim());
  return chunks;
};

const chunkTable = (rows, size) => {
  const chunks = [];
  for (let i = 0; i < rows.length; i += size) {
    const slice = rows.slice(i, i + size);
    chunks.push(JSON.stringify(slice, null, 2));
  }
  return chunks;
};

// --- SEARCH ENGINE ---
const searchChunks = (query, categoryFilter = null) => {
  const allChunks = readJson(CHUNKS_FILE, []);
  if (!allChunks.length) return [];

  const queryLower = query.toLowerCase();
  const queryTerms = queryLower.split(/\s+/).filter(w => w.length > 2);

  return allChunks
    .map(chunk => {
      // 1. Hard Filter by Category
      if (categoryFilter && categoryFilter !== 'Geral' && chunk.category !== categoryFilter) {
        return { ...chunk, score: -1 };
      }

      let score = 0;
      const contentLower = chunk.content.toLowerCase();
      
      // 2. Keyword Matching
      queryTerms.forEach(term => {
        if (contentLower.includes(term)) score += 1;
      });

      // 3. Metadata Boost
      if (chunk.caseName && queryLower.includes(chunk.caseName.toLowerCase())) score += 3;
      if (chunk.description && queryLower.includes(chunk.description.toLowerCase())) score += 2;
      if (chunk.period && queryLower.includes(chunk.period.toLowerCase())) score += 2;

      return { ...chunk, score };
    })
    .filter(c => c.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6); // Top 6 chunks
};

// --- ROUTES ---

// 1. GET FILES
app.get('/api/files', (req, res) => {
  const db = readJson(DB_FILE, { files: [] });
  res.json(db.files);
});

// 2. UPLOAD
app.post('/api/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });

  const { description, source, period, caseName, category } = req.body;
  const fileId = crypto.randomUUID();

  try {
    console.log(`[Processing] ${req.file.originalname}`);
    const contentChunks = await processFile(req.file.path, req.file.originalname, req.file.mimetype);

    // Save Metadata
    const db = readJson(DB_FILE, { files: [] });
    const newFile = {
      id: fileId,
      name: req.file.originalname,
      type: path.extname(req.file.originalname).replace('.', ''),
      timestamp: Date.now(),
      description,
      source,
      period,
      caseName,
      category
    };
    db.files.push(newFile);
    writeJson(DB_FILE, db);

    // Save Chunks
    const allChunks = readJson(CHUNKS_FILE, []);
    const newChunks = contentChunks.map((c, i) => ({
      id: `${fileId}_${i}`,
      fileId,
      content: c,
      category,
      caseName,
      description,
      source,
      period
    }));
    writeJson(CHUNKS_FILE, [...allChunks, ...newChunks]);

    res.json(newFile);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Processing failed' });
  }
});

// 3. DELETE
app.delete('/api/files/:id', (req, res) => {
  const { id } = req.params;
  
  const db = readJson(DB_FILE, { files: [] });
  db.files = db.files.filter(f => f.id !== id);
  writeJson(DB_FILE, db);

  const allChunks = readJson(CHUNKS_FILE, []);
  const remainingChunks = allChunks.filter(c => c.fileId !== id);
  writeJson(CHUNKS_FILE, remainingChunks);

  res.json({ success: true });
});

// 4. ASK / CHAT
app.post('/api/ask', async (req, res) => {
  const { message, history } = req.body;

  try {
    // 1. Retrieval
    const relevantChunks = searchChunks(message);
    const contextText = relevantChunks.map(c => 
      `FONTE: ${c.caseName || 'Doc'} (${c.period || ''}) - ${c.description || ''}\nCONTEÚDO:\n${c.content}`
    ).join('\n\n---\n\n');

    // 2. Prepare Gemini
    const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
    
    // 3. System Prompt
    const systemInstruction = `Você é o Gonçalinho, assistente de dados de São Gonçalo dos Campos.
    
    DIRETRIZES:
    1. Responda APENAS com base no CONTEXTO fornecido abaixo.
    2. Se a informação não estiver no contexto, diga que não encontrou nos arquivos disponíveis.
    3. Seja direto e use formatação Markdown (tabelas, negrito).
    4. Cite as fontes (nome do arquivo/caso) quando apresentar dados.
    5. Mantenha tom profissional e técnico.

    CONTEXTO RECUPERADO:
    ${contextText}`;

    // 4. Chat History (Truncate to last 2 turns to save context window)
    const recentHistory = history ? history.slice(-2) : [];
    // Format history for Gemini contents if needed, but for simple QA 
    // with heavy context, single turn often works best.
    // We will append the user query to the context.

    const finalPrompt = `Pergunta: ${message}`;

    const response = await ai.models.generateContentStream({
      model: 'gemini-2.5-flash',
      config: {
        systemInstruction: systemInstruction,
      },
      contents: [
        // Optional: Add recent history if formatted correctly as 'user'/'model' parts
        ...recentHistory.map(h => ({ 
            role: h.role === 'model' ? 'model' : 'user', 
            parts: [{ text: h.text }] 
        })),
        { role: 'user', parts: [{ text: finalPrompt }] }
      ],
    });

    // 5. Stream Response
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');

    for await (const chunk of response) {
      const text = chunk.text;
      if (text) {
        res.write(text);
      }
    }
    
    // Append Sources Metadata at the end
    if (relevantChunks.length > 0) {
      const uniqueSources = [...new Set(relevantChunks.map(c => c.caseName || c.source))].join(', ');
      res.write(`\n\n*Fontes consultadas: ${uniqueSources}*`);
    }

    res.end();

  } catch (error) {
    console.error("Gemini Error:", error);
    res.write("**Erro no servidor:** Não foi possível processar a resposta. Verifique os logs.");
    res.end();
  }
});

// --- SERVE FRONTEND ---
const distPath = path.join(__dirname, 'dist');
app.use(express.static(distPath));
app.get('*', (req, res) => {
  if (fs.existsSync(path.join(distPath, 'index.html'))) {
    res.sendFile(path.join(distPath, 'index.html'));
  } else {
    res.send("Gonçalinho API Server Running. Build frontend to see UI.");
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Data Storage: ${DATA_DIR}`);
});
