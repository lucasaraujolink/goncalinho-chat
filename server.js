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
let DATA_DIR = LOCAL_DATA_PATH;
try {
  if (fs.existsSync('/var/www')) {
    fs.accessSync('/var/www', fs.constants.W_OK);
    DATA_DIR = VPS_DATA_PATH;
  }
} catch (e) {
  console.log("Using local storage path due to permissions or missing directory.");
}

const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const CHUNKS_FILE = path.join(DATA_DIR, 'chunks.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// --- MIDDLEWARE ---
const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({ 
  dest: UPLOAD_DIR,
  limits: { fileSize: 50 * 1024 * 1024 } 
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
      chunks = chunkText(data.text, 1000);
    } else if (ext === '.docx') {
      const result = await mammoth.extractRawText({ path: filePath });
      chunks = chunkText(result.value, 1500);
    } else if (ext === '.csv') {
      // 1. Read buffer to handle encoding manually
      const buffer = fs.readFileSync(filePath);
      
      // 2. Simple Encoding Detection
      // First try UTF-8. If it contains replacement char (), fallback to Latin1 (common in BR Gov files)
      let fileContent = buffer.toString('utf8');
      if (fileContent.includes('\ufffd')) {
        fileContent = buffer.toString('latin1');
      }

      // 3. Robust Parsing options
      const records = parse(fileContent, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
        bom: true, // Handle Byte Order Mark
        delimiter: [';', ',', '\t', '|'], // Auto-detect separator, prioritizing semicolon
        relax_quotes: true, // Fix for "Invalid Opening Quote"
        relax_column_count: true, // Allow rows with different column counts
        skip_records_with_error: true // Skip lines that are totally broken instead of crashing
      });
      chunks = chunkTable(records, 20); // Reduced to 20 for better context
    } else if (ext === '.xlsx' || ext === '.xls') {
      const workbook = xlsx.readFile(filePath);
      let allRecords = [];
      workbook.SheetNames.forEach(sheetName => {
        const rows = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName]);
        // Add sheet context to every row
        const rowsWithContext = rows.map(r => {
          const newRow = { _aba: sheetName, ...r };
          return newRow;
        });
        allRecords = allRecords.concat(rowsWithContext);
      });
      chunks = chunkTable(allRecords, 20); // Reduced to 20
    } else if (ext === '.txt') {
      // Handle encoding for TXT as well
      const buffer = fs.readFileSync(filePath);
      let text = buffer.toString('utf8');
      if (text.includes('\ufffd')) {
        text = buffer.toString('latin1');
      }
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

// Improved Table Chunking: Converts to CSV-like string using semicolons
// This prevents confusion with decimal commas (e.g., 1,50)
const chunkTable = (rows, size) => {
  const chunks = [];
  if (rows.length === 0) return chunks;

  // Get headers from the first row
  const headers = Object.keys(rows[0]);

  for (let i = 0; i < rows.length; i += size) {
    const slice = rows.slice(i, i + size);
    
    // Create a text representation: Header + Rows
    // Using semicolon (;) to separate columns to support Brazilian number formats
    let chunkText = headers.join(' ; ') + '\n';
    chunkText += slice.map(row => {
      return headers.map(h => {
        let val = row[h];
        // Ensure null/undefined doesn't break
        if (val === null || val === undefined) return '';
        // Clean line breaks inside cells
        return String(val).replace(/[\n\r]+/g, ' ').trim();
      }).join(' ; ');
    }).join('\n');

    chunks.push(chunkText);
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
      if (categoryFilter && categoryFilter !== 'Geral' && chunk.category !== categoryFilter) {
        return { ...chunk, score: -1 };
      }

      let score = 0;
      const contentLower = chunk.content.toLowerCase();
      
      queryTerms.forEach(term => {
        if (contentLower.includes(term)) score += 1;
      });

      if (chunk.caseName && queryLower.includes(chunk.caseName.toLowerCase())) score += 3;
      if (chunk.description && queryLower.includes(chunk.description.toLowerCase())) score += 2;
      
      return { ...chunk, score };
    })
    .filter(c => c.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 15); // Increased to 15 to provide deeper context
};

// --- ROUTES ---

app.get('/api/files', (req, res) => {
  const db = readJson(DB_FILE, { files: [] });
  res.json(db.files);
});

app.post('/api/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });

  const { description, source, period, caseName, category } = req.body;
  const fileId = crypto.randomUUID();

  try {
    console.log(`[Processing] ${req.file.originalname}`);
    const contentChunks = await processFile(req.file.path, req.file.originalname, req.file.mimetype);

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

    const allChunks = readJson(CHUNKS_FILE, []);
    const newChunks = contentChunks.map((c, i) => ({
      id: `${fileId}_${i}`,
      fileId,
      content: c,
      category,
      caseName,
      description,
      source,
      period,
      fileName: req.file.originalname
    }));
    writeJson(CHUNKS_FILE, [...allChunks, ...newChunks]);

    res.json(newFile);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Processing failed' });
  }
});

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

app.post('/api/ask', async (req, res) => {
  const { message, history } = req.body;

  try {
    const relevantChunks = searchChunks(message);
    
    // Improved Context Formatting: Explicitly label Source vs CaseName
    const contextText = relevantChunks.map(c => 
      `--- INÍCIO DO BLOCO DE DADOS ---
       ARQUIVO: ${c.fileName}
       FONTE (ORIGEM): ${c.source || 'Não especificada'}
       INDICADOR (TEMA): ${c.caseName || 'Geral'}
       PERÍODO: ${c.period || 'Não especificado'}
       DESCRIÇÃO: ${c.description || ''}
       
       CONTEÚDO (DADOS - SEPARADO POR PONTO E VÍRGULA):
       ${c.content}
       --- FIM DO BLOCO ---`
    ).join('\n\n');

    const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
    
    const systemInstruction = `Você é o Gonçalinho, um analista de dados especialista em indicadores públicos.

    OBJETIVO:
    Fornecer análises precisas, citar fontes corretamente e GERAR GRÁFICOS VISUAIS sempre que houver dados numéricos comparáveis.

    REGRAS DE ANÁLISE:
    1. Baseie-se ESTRITAMENTE no CONTEXTO fornecido. Não invente números.
    2. Ao citar a fonte, use o campo "FONTE (ORIGEM)" e "ARQUIVO". Não confunda com o nome do indicador.
    3. Para tabelas e CSVs: Os dados estão separados por PONTO E VÍRGULA (;). A primeira linha contém os cabeçalhos. Se houver múltiplas colunas, analise a relação entre elas.

    GERAÇÃO DE GRÁFICOS (IMPORTANTE):
    Se a resposta envolver comparação de números (ex: evolução anual, comparação entre bairros, categorias, gastos), você DEVE fornecer um JSON no final da resposta para renderizar o gráfico.
    
    FORMATO DO JSON DE GRÁFICO:
    Coloque o JSON dentro de um bloco de código markdown assim:
    \`\`\`json
    {
      "type": "bar" | "line" | "pie" | "area",
      "title": "Título descritivo do gráfico",
      "description": "Breve explicação do que o gráfico mostra",
      "data": [
        { "name": "Categoria A", "value": 100 },
        { "name": "Categoria B", "value": 150 }
      ],
      "xAxisKey": "name",
      "dataKeys": ["value"]
    }
    \`\`\`
    
    Use "bar" para comparações diretas, "line" para evolução temporal, "pie" para partes de um todo.
    Priorize gerar o gráfico ANTES ou DEPOIS do texto explicativo.
    `;

    const recentHistory = history ? history.slice(-4) : []; 
    const finalPrompt = `Pergunta do usuário: ${message}`;

    const response = await ai.models.generateContentStream({
      model: 'gemini-2.5-flash',
      config: {
        systemInstruction: systemInstruction,
        temperature: 0.3, // Lower temperature for more factual data analysis
      },
      contents: [
        ...recentHistory.map(h => ({ 
            role: h.role === 'model' ? 'model' : 'user', 
            parts: [{ text: h.text }] 
        })),
        { role: 'user', parts: [{ text: systemInstruction + "\n\nCONTEXTO:\n" + contextText + "\n\n" + finalPrompt }] }
      ],
    });

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');

    for await (const chunk of response) {
      const text = chunk.text;
      if (text) res.write(text);
    }
    
    res.end();

  } catch (error) {
    console.error("Gemini Error:", error);
    res.write("**Erro no servidor:** Não foi possível processar a resposta. Verifique os logs.");
    res.end();
  }
});

const distPath = path.join(__dirname, 'dist');
app.use(express.static(distPath));
app.get('*', (req, res) => {
  if (fs.existsSync(path.join(distPath, 'index.html'))) {
    res.sendFile(path.join(distPath, 'index.html'));
  } else {
    res.send("Gonçalinho API Server Running.");
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Data Storage: ${DATA_DIR}`);
});