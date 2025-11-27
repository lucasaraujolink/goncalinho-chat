import { UploadedFile, Message } from '../types';

const API_URL = '/api';

export const api = {
  async getAllFiles(): Promise<UploadedFile[]> {
    // Let the component handle the error
    const res = await fetch(`${API_URL}/files`);
    if (!res.ok) throw new Error('Failed to fetch files');
    return res.json();
  },

  async uploadFile(file: File, metadata: any): Promise<UploadedFile> {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('description', metadata.description || '');
    formData.append('source', metadata.source || '');
    formData.append('period', metadata.period || '');
    formData.append('caseName', metadata.caseName || '');
    formData.append('category', metadata.category || 'Geral');

    const res = await fetch(`${API_URL}/upload`, {
      method: 'POST',
      body: formData,
    });

    if (!res.ok) throw new Error('Upload failed');
    return res.json();
  },

  async deleteFile(id: string): Promise<void> {
    const res = await fetch(`${API_URL}/files/${id}`, {
      method: 'DELETE',
    });
    if (!res.ok) throw new Error('Delete failed');
  },

  async sendMessageStream(message: string, history: Message[], onChunk: (chunk: string) => void): Promise<void> {
    const res = await fetch(`${API_URL}/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message,
        history: history.map(h => ({ role: h.role, text: h.text }))
      }),
    });

    if (!res.body) throw new Error('No response body');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      onChunk(chunk);
    }
  }
};