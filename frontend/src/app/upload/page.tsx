'use client';

import { useCallback, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { motion } from 'framer-motion';
import { RequireAuth } from '@/components/auth/RequireAuth';
import { BackButton } from '@/components/ui/BackButton';
import { PixelButton } from '@/components/ui/PixelButton';
import { PixelInput } from '@/components/ui/PixelInput';
import { importAgentArchive, importAgentFolder, type Agent } from '@/lib/agents';
import {
  CLI_RUNTIMES,
  detectRuntimeFromPaths,
  RUNTIME_LABELS,
  type CliRuntime,
  type DetectionResult,
} from '@/lib/runtime-detect';

type UploadMode = 'folder' | 'zip';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function ModeGlyph({ mode }: { mode: UploadMode }) {
  if (mode === 'folder') {
    return (
      <svg viewBox="0 0 24 24" className="h-8 w-8" aria-hidden="true" shapeRendering="crispEdges">
        <path fill="currentColor" d="M3 5h7l2 2h9v12H3V5Z" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" className="h-8 w-8" aria-hidden="true" shapeRendering="crispEdges">
      <path fill="currentColor" d="M5 3h14v18H5V3Zm6 2v2h2V5h-2Zm-2 2v2h2V7H9Zm2 2v2h2V9h-2Zm-2 2v2h2v-2H9Zm2 2v4h2v-4h-2Z" />
    </svg>
  );
}

function UploadPageInner() {
  const router = useRouter();
  const folderInputRef = useRef<HTMLInputElement>(null);
  const zipInputRef = useRef<HTMLInputElement>(null);

  const [mode, setMode] = useState<UploadMode>('folder');
  const [folderFiles, setFolderFiles] = useState<File[]>([]);
  const [zipFile, setZipFile] = useState<File | null>(null);
  const [agentName, setAgentName] = useState('');
  const [description, setDescription] = useState('');
  const [detection, setDetection] = useState<DetectionResult | null>(null);
  const [selectedRuntime, setSelectedRuntime] = useState<CliRuntime | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState('');
  const [createdAgent, setCreatedAgent] = useState<Agent | null>(null);

  const hasSelection = mode === 'folder' ? folderFiles.length > 0 : zipFile !== null;
  const totalSize =
    mode === 'folder' ? folderFiles.reduce((sum, f) => sum + f.size, 0) : (zipFile?.size ?? 0);

  const effectiveRuntime: CliRuntime | null =
    selectedRuntime ?? (detection?.confidence === 'high' ? detection.detected : null);
  // zip contents cannot be inspected client-side, so zips always show the picker.
  const showRuntimePicker =
    hasSelection && (mode === 'zip' || detection?.confidence !== 'high' || !effectiveRuntime);

  const resetSelection = useCallback(() => {
    setFolderFiles([]);
    setZipFile(null);
    setAgentName('');
    setDetection(null);
    setSelectedRuntime(null);
    setError('');
    setCreatedAgent(null);
    setProgress(0);
  }, []);

  const switchMode = (next: UploadMode) => {
    if (next === mode) return;
    setMode(next);
    resetSelection();
  };

  const handleFolderSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    if (files.length === 0) return;
    resetSelection();
    setFolderFiles(files);

    const paths = files.map((f) => f.webkitRelativePath || f.name);
    const rootFolder = (paths[0] ?? 'my-agent').split('/')[0] || 'my-agent';
    setAgentName(rootFolder);
    const result = detectRuntimeFromPaths(paths);
    setDetection(result);
    if (result.confidence === 'high' && result.detected) setSelectedRuntime(result.detected);
  };

  const handleZipSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.zip')) {
      setError('Zip mode only accepts .zip files.');
      return;
    }
    resetSelection();
    setZipFile(file);
    setAgentName(file.name.replace(/\.[^/.]+$/, ''));
    setDetection({ detected: null, confidence: 'none', scores: { 'claude-code': 0, codex: 0, opencode: 0, hermes: 0, openclaw: 0 } });
  };

  const handleUpload = async () => {
    if (isUploading) return;
    if (!agentName.trim()) {
      setError('Give the agent a name first.');
      return;
    }
    if (!hasSelection) {
      setError(mode === 'folder' ? 'Pick a folder to upload.' : 'Pick a .zip file to upload.');
      return;
    }
    if (!effectiveRuntime) {
      setError('Choose the agent runtime.');
      return;
    }

    setIsUploading(true);
    setError('');
    setProgress(15);

    try {
      const input = {
        name: agentName.trim(),
        runtime: effectiveRuntime,
        description: description.trim() || undefined,
      };
      setProgress(45);
      const result =
        mode === 'folder'
          ? await importAgentFolder({
              ...input,
              files: folderFiles.map((file) => ({
                relativePath: file.webkitRelativePath || file.name,
                file,
              })),
            })
          : await importAgentArchive({ ...input, archive: zipFile! });
      setProgress(80);
      setProgress(100);
      setCreatedAgent(result.agent);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
      setProgress(0);
    } finally {
      setIsUploading(false);
    }
  };

  if (createdAgent) {
    return (
      <div className="mx-auto max-w-3xl px-4 pb-16">
        <BackButton href="/" />
        <motion.div
          initial={{ opacity: 0, scale: 0.94 }}
          animate={{ opacity: 1, scale: 1 }}
          className="border border-pixel-line bg-pixel-white p-8 text-center"
          style={{ boxShadow: '8px 8px 0 rgba(17,17,17,0.10)' }}
        >
          <h1 className="brand-large mb-2 text-pixel-black">Agent on board!</h1>
          <p className="font-sans text-sm text-pixel-black/60">
            “{createdAgent.name}” joined your den as a {RUNTIME_LABELS[createdAgent.runtime]} agent.
          </p>
          <div className="mt-6 flex flex-wrap justify-center gap-3">
            <PixelButton variant="primary" onClick={() => router.push(`/agents/${createdAgent.id}/settings`)}>
              Configure provider
            </PixelButton>
            <PixelButton variant="secondary" onClick={() => router.push(`/agents/${createdAgent.id}`)}>
              Start chatting
            </PixelButton>
            <PixelButton variant="danger" onClick={resetSelection}>
              Upload another
            </PixelButton>
          </div>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl px-4 pb-16">
      <BackButton href="/" />

      <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="mb-8 text-center">
        <h1 className="brand-large mb-2 text-pixel-black">Upload Agent</h1>
        <p className="font-sans text-xl text-pixel-blue">BRING YOUR OWN AGENT</p>
        <p className="mt-2 font-sans text-sm text-pixel-black/60">
          Import a workspace folder or zip archive; the runtime is detected from its files.
        </p>
      </motion.div>

      <div className="mb-6 grid grid-cols-2 gap-4">
        {(['folder', 'zip'] as UploadMode[]).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => switchMode(m)}
            className={`flex flex-col items-center gap-2 border border-pixel-line p-5 font-sans transition-colors ${
              mode === m ? 'bg-pixel-blue text-pixel-white' : 'bg-pixel-white text-pixel-black hover:bg-pixel-cream'
            }`}
            style={{ boxShadow: mode === m ? '5px 5px 0 rgba(17,17,17,0.10)' : '3px 3px 0 rgba(17,17,17,0.10)' }}
          >
            <ModeGlyph mode={m} />
            <span className="text-lg font-bold">{m === 'folder' ? 'Folder' : 'Zip archive'}</span>
            <span className={`text-xs ${mode === m ? 'text-pixel-white/80' : 'text-pixel-black/55'}`}>
              {m === 'folder' ? 'Pick a workspace directory' : 'Pick a packed .zip'}
            </span>
          </button>
        ))}
      </div>

      <div className="border border-pixel-line bg-pixel-white p-5" style={{ boxShadow: '6px 6px 0 rgba(17,17,17,0.10)' }}>
        {!hasSelection ? (
          <div className="py-8 text-center">
            <p className="mb-4 font-sans text-sm text-pixel-black/60">
              {mode === 'folder'
                ? 'Select the agent workspace folder (config dirs like .claude included).'
                : 'Select a .zip archive of the agent workspace.'}
            </p>
            <PixelButton
              variant="primary"
              size="lg"
              onClick={() => (mode === 'folder' ? folderInputRef.current?.click() : zipInputRef.current?.click())}
            >
              {mode === 'folder' ? 'Choose folder' : 'Choose zip'}
            </PixelButton>
            <input
              ref={folderInputRef}
              type="file"
              className="hidden"
              // @ts-expect-error non-standard directory attributes
              webkitdirectory=""
              directory=""
              multiple
              onChange={handleFolderSelect}
            />
            <input ref={zipInputRef} type="file" accept=".zip" className="hidden" onChange={handleZipSelect} />
          </div>
        ) : (
          <div className="space-y-5">
            <div className="flex items-center justify-between gap-3 border border-pixel-line bg-pixel-cream p-3">
              <div className="min-w-0">
                <p className="truncate font-sans text-sm font-bold text-pixel-black">
                  {mode === 'folder' ? `${folderFiles.length} files selected` : zipFile?.name}
                </p>
                <p className="font-sans text-xs text-pixel-black/55">{formatBytes(totalSize)}</p>
              </div>
              <button
                type="button"
                onClick={resetSelection}
                className="shrink-0 border border-pixel-line bg-pixel-white px-2 py-1 font-sans text-xs text-pixel-black hover:bg-pixel-cream"
                style={{ boxShadow: '2px 2px 0 rgba(17,17,17,0.10)' }}
              >
                Reselect
              </button>
            </div>

            {detection && mode === 'folder' && (
              <div
                className={`border p-3 font-sans text-sm ${
                  detection.confidence === 'high'
                    ? 'border-pixel-green bg-pixel-green/10 text-pixel-green'
                    : 'border-pixel-yellow bg-pixel-yellow/10 text-pixel-black'
                }`}
              >
                {detection.confidence === 'high' && detection.detected
                  ? `Runtime detected: ${RUNTIME_LABELS[detection.detected]}`
                  : detection.confidence === 'low' && detection.detected
                    ? `Runtime guess: ${RUNTIME_LABELS[detection.detected]} — confirm below`
                    : 'Runtime not detected — pick one below'}
              </div>
            )}

            {showRuntimePicker && (
              <div>
                <label className="mb-2 block font-sans text-sm text-pixel-black">Agent runtime</label>
                <div className="flex flex-wrap gap-2">
                  {CLI_RUNTIMES.map((runtime) => (
                    <button
                      key={runtime}
                      type="button"
                      onClick={() => setSelectedRuntime(runtime)}
                      className={`border border-pixel-line px-3 py-2 font-sans text-sm transition-colors ${
                        effectiveRuntime === runtime
                          ? 'bg-pixel-blue text-pixel-white'
                          : 'bg-pixel-white text-pixel-black hover:bg-pixel-cream'
                      }`}
                      style={{ boxShadow: '2px 2px 0 rgba(17,17,17,0.10)' }}
                    >
                      {RUNTIME_LABELS[runtime]}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div>
              <label className="mb-1 block font-sans text-sm text-pixel-black">Agent name</label>
              <PixelInput value={agentName} onChange={setAgentName} placeholder="My agent" />
            </div>

            <div>
              <label className="mb-1 block font-sans text-sm text-pixel-black">Description (optional)</label>
              <PixelInput value={description} onChange={setDescription} placeholder="What is this agent good at?" multiline rows={3} />
            </div>


            {error && (
              <div className="border border-pixel-red bg-pixel-red/10 p-3">
                <p className="font-sans text-sm text-pixel-red">{error}</p>
              </div>
            )}

            {isUploading && (
              <div className="space-y-2">
                <div className="relative h-4 overflow-hidden border border-pixel-line bg-pixel-white">
                  <motion.div className="h-full bg-pixel-green" animate={{ width: `${progress}%` }} />
                </div>
                <p className="text-center font-sans text-xs text-pixel-black/55">Uploading… {progress}%</p>
              </div>
            )}

            <PixelButton
              variant="primary"
              size="lg"
              className="w-full"
              disabled={isUploading}
              onClick={() => void handleUpload()}
            >
              {isUploading ? 'Uploading…' : 'Import agent'}
            </PixelButton>
          </div>
        )}
      </div>

    </div>
  );
}

export default function UploadPage() {
  return (
    <RequireAuth>
      <UploadPageInner />
    </RequireAuth>
  );
}
