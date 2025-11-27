export enum FileType {
  CSV = 'csv',
  XLSX = 'xlsx',
  DOCX = 'docx',
  PDF = 'pdf',
  TXT = 'txt',
  JSON = 'json',
  UNKNOWN = 'unknown'
}

export type FileCategory = 
  | 'Finanças'
  | 'Educação'
  | 'Desenvolvimento Social'
  | 'Infraestrutura'
  | 'Planejamento'
  | 'Esporte cultura e lazer'
  | 'Saúde'
  | 'Gabinete'
  | 'Geral';

export interface UploadedFile {
  id: string;
  name: string;
  type: string; // Simplified
  timestamp: number;
  // Metadata added for the "Gonçalinho" context
  description?: string;
  source?: string;
  period?: string;
  caseName?: string;
  category: FileCategory;
  // NOTE: 'content' is removed from frontend type to save memory. 
  // It resides in backend/chunks now.
}

export interface ChartData {
  type: 'bar' | 'line' | 'pie' | 'area';
  title: string;
  data: any[];
  dataKeys?: string[]; 
  xAxisKey?: string; 
  description?: string;
}

export interface Message {
  id: string;
  role: 'user' | 'model';
  text: string;
  timestamp: number;
  isLoading?: boolean;
  chartData?: ChartData; 
}
