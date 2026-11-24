import React from 'react';
import { FileArchive, FileAudio, FileText, Film, Image as ImageIcon, File as FileIcon } from 'lucide-react';

interface FilePreviewThumbProps {
  category: 'video' | 'image' | 'audio' | 'document' | 'archive' | 'other';
  previewDataUrl?: string;
  name: string;
}

export const FilePreviewThumb: React.FC<FilePreviewThumbProps> = ({
  category,
  previewDataUrl,
  name,
}) => {
  if (previewDataUrl) {
    return (
      <div className="relative w-14 h-11 rounded-lg overflow-hidden bg-slate-100 border border-slate-200 shrink-0">
        <img
          src={previewDataUrl}
          alt={`Pratinjau ${name}`}
          className="w-full h-full object-cover"
          referrerPolicy="no-referrer"
        />
        {category === 'video' && (
          <div className="absolute inset-0 bg-black/20 flex items-center justify-center">
            <Film className="w-4 h-4 text-white drop-shadow" aria-hidden="true" />
          </div>
        )}
      </div>
    );
  }

  const iconMap = {
    video: <Film className="w-5 h-5 text-blue-600" aria-hidden="true" />,
    image: <ImageIcon className="w-5 h-5 text-blue-600" aria-hidden="true" />,
    audio: <FileAudio className="w-5 h-5 text-slate-600" aria-hidden="true" />,
    document: <FileText className="w-5 h-5 text-slate-600" aria-hidden="true" />,
    archive: <FileArchive className="w-5 h-5 text-slate-600" aria-hidden="true" />,
    other: <FileIcon className="w-5 h-5 text-slate-600" aria-hidden="true" />,
  };

  return (
    <div className="w-14 h-11 rounded-lg bg-slate-100 border border-slate-200 flex items-center justify-center shrink-0">
      {iconMap[category]}
    </div>
  );
};
