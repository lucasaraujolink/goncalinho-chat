import React, { useRef, useState } from 'react';
import { Upload } from 'lucide-react';

interface FileUploaderProps {
  onFileSelected: (file: File) => void;
}

export const FileUploader: React.FC<FileUploaderProps> = ({ onFileSelected }) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragActive, setDragActive] = useState(false);

  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') {
      setDragActive(true);
    } else if (e.type === 'dragleave') {
      setDragActive(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      onFileSelected(e.dataTransfer.files[0]);
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    e.preventDefault();
    if (e.target.files && e.target.files[0]) {
      onFileSelected(e.target.files[0]);
    }
    // Reset input
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const triggerSelect = () => {
    fileInputRef.current?.click();
  };

  return (
    <div className="w-full">
      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        accept=".csv,.xlsx,.xls,.docx,.txt,.pdf"
        onChange={handleChange}
      />
      
      <div
        className={`relative flex flex-col items-center justify-center w-full p-8 border-2 border-dashed rounded-xl transition-all duration-200 ease-in-out cursor-pointer group
          ${dragActive 
            ? 'border-emerald-500 bg-emerald-500/10 scale-[1.02]' 
            : 'border-slate-700 hover:border-emerald-500/50 hover:bg-slate-800/50'
          }
        `}
        onDragEnter={handleDrag}
        onDragLeave={handleDrag}
        onDragOver={handleDrag}
        onDrop={handleDrop}
        onClick={triggerSelect}
      >
        <div className="p-4 bg-slate-800 rounded-full mb-4 group-hover:scale-110 transition-transform duration-200">
          <Upload className={`w-8 h-8 text-slate-400 group-hover:text-emerald-400 transition-colors`} />
        </div>
        <p className="mb-2 text-sm text-slate-300 font-medium text-center">
          <span className="font-bold text-emerald-400">Clique para selecionar</span> ou arraste
        </p>
        <p className="text-xs text-slate-500 text-center max-w-[200px]">
          Suporta CSV, XLSX, PDF, DOCX e TXT
        </p>
      </div>
    </div>
  );
};
