import { useEffect, useMemo } from "react";
import dynamic from "next/dynamic";
import {
  PacketType,
  PythonToolPacket,
  PythonToolStart,
  PythonToolDelta,
  SectionEnd,
} from "@/app/app/services/streamingModels";
import {
  MessageRenderer,
  RenderType,
} from "@/app/app/message/messageComponents/interfaces";
import { CodeBlock } from "@/app/app/message/CodeBlock";
import hljs from "highlight.js/lib/core";
import python from "highlight.js/lib/languages/python";
import { SvgTerminal } from "@opal/icons";
import FadingEdgeContainer from "@/refresh-components/FadingEdgeContainer";

const KmzMapPreview = dynamic(
  () => import("@/components/kmz/KmzMapPreview"),
  { ssr: false }
);

// Register Python language for highlighting
hljs.registerLanguage("python", python);

interface GeneratedFileRef {
  id: string;
  name?: string;
}

function isKmzOrKmlName(name: string | undefined): boolean {
  if (!name) {
    return false;
  }
  const lower = name.toLowerCase();
  return lower.endsWith(".kmz") || lower.endsWith(".kml");
}

// Component to render syntax-highlighted Python code
function HighlightedPythonCode({ code }: { code: string }) {
  const highlightedHtml = useMemo(() => {
    try {
      return hljs.highlight(code, { language: "python" }).value;
    } catch {
      return code;
    }
  }, [code]);

  return (
    <span
      dangerouslySetInnerHTML={{ __html: highlightedHtml }}
      className="hljs"
    />
  );
}

// Helper function to construct current Python execution state
function constructCurrentPythonState(packets: PythonToolPacket[]) {
  const pythonStart = packets.find(
    (packet) => packet.obj.type === PacketType.PYTHON_TOOL_START
  )?.obj as PythonToolStart | null;
  const pythonDeltas = packets
    .filter((packet) => packet.obj.type === PacketType.PYTHON_TOOL_DELTA)
    .map((packet) => packet.obj as PythonToolDelta);
  const pythonEnd = packets.find(
    (packet) =>
      packet.obj.type === PacketType.SECTION_END ||
      packet.obj.type === PacketType.ERROR
  )?.obj as SectionEnd | null;

  const code = pythonStart?.code || "";
  const stdout = pythonDeltas
    .map((delta) => delta?.stdout || "")
    .filter((s) => s)
    .join("");
  const stderr = pythonDeltas
    .map((delta) => delta?.stderr || "")
    .filter((s) => s)
    .join("");
  const generatedFiles: GeneratedFileRef[] = [];
  const seenFileIds = new Set<string>();
  for (const delta of pythonDeltas) {
    const ids = delta?.file_ids || [];
    const names = delta?.file_names || [];
    ids.forEach((fileId, index) => {
      if (!fileId || seenFileIds.has(fileId)) {
        return;
      }
      seenFileIds.add(fileId);
      generatedFiles.push({ id: fileId, name: names[index] });
    });
  }
  const fileIds = generatedFiles.map((file) => file.id);
  const kmzGeneratedFiles = generatedFiles.filter((file) =>
    isKmzOrKmlName(file.name)
  );
  const isExecuting = pythonStart && !pythonEnd;
  const isComplete = pythonStart && pythonEnd;
  const hasError = stderr.length > 0;

  return {
    code,
    stdout,
    stderr,
    fileIds,
    generatedFiles,
    kmzGeneratedFiles,
    isExecuting,
    isComplete,
    hasError,
  };
}

export const PythonToolRenderer: MessageRenderer<PythonToolPacket, {}> = ({
  packets,
  onComplete,
  renderType,
  children,
}) => {
  const {
    code,
    stdout,
    stderr,
    fileIds,
    kmzGeneratedFiles,
    isExecuting,
    isComplete,
    hasError,
  } = constructCurrentPythonState(packets);

  useEffect(() => {
    if (isComplete) {
      onComplete();
    }
  }, [isComplete, onComplete]);

  const status = useMemo(() => {
    if (isExecuting) {
      return "Executing Python code...";
    }
    if (hasError) {
      return "Python execution failed";
    }
    if (isComplete) {
      return "Python execution completed";
    }
    return "Python execution";
  }, [isComplete, isExecuting, hasError]);

  // Shared content for all states - used by both FULL and compact modes
  const content = (
    <div className="flex flex-col mb-1 space-y-2">
      {/* Loading indicator when executing */}
      {isExecuting && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <div className="flex gap-0.5">
            <div className="w-1 h-1 bg-current rounded-full animate-pulse"></div>
            <div
              className="w-1 h-1 bg-current rounded-full animate-pulse"
              style={{ animationDelay: "0.1s" }}
            ></div>
            <div
              className="w-1 h-1 bg-current rounded-full animate-pulse"
              style={{ animationDelay: "0.2s" }}
            ></div>
          </div>
          <span>Running code...</span>
        </div>
      )}

      {/* Code block */}
      {code && (
        <div className="prose max-w-full">
          <CodeBlock className="language-python" codeText={code.trim()}>
            <HighlightedPythonCode code={code.trim()} />
          </CodeBlock>
        </div>
      )}

      {/* Output */}
      {stdout && (
        <div className="rounded-md bg-background-neutral-02 p-3">
          <div className="text-xs font-semibold mb-1 text-text-03">Output:</div>
          <pre className="text-sm whitespace-pre-wrap font-mono text-text-01 overflow-x-auto">
            {stdout}
          </pre>
        </div>
      )}

      {/* Error */}
      {stderr && (
        <div className="rounded-md bg-status-error-01 p-3 border border-status-error-02">
          <div className="text-xs font-semibold mb-1 text-status-error-05">
            Error:
          </div>
          <pre className="text-sm whitespace-pre-wrap font-mono text-status-error-05 overflow-x-auto">
            {stderr}
          </pre>
        </div>
      )}

      {/* File count */}
      {fileIds.length > 0 && (
        <div className="text-sm text-text-03">
          Generated {fileIds.length} file{fileIds.length !== 1 ? "s" : ""}
        </div>
      )}

      {/* Lightweight in-chat map preview for generated KMZ/KML files */}
      {kmzGeneratedFiles.map((file) => (
        <div key={file.id} className="rounded-lg border border-border p-2">
          <div className="mb-2 text-xs text-muted-foreground">
            Map preview{file.name ? ` | ${file.name}` : ""}
          </div>
          <KmzMapPreview
            fileId={file.id}
            fileName={file.name || "KMZ Output"}
          />
        </div>
      ))}

      {/* No output fallback - only when complete with no output */}
      {isComplete && !stdout && !stderr && (
        <div className="py-2 text-center text-text-04">
          <SvgTerminal className="w-4 h-4 mx-auto mb-1 opacity-50" />
          <p className="text-xs">No output</p>
        </div>
      )}
    </div>
  );

  // FULL mode: render content directly
  if (renderType === RenderType.FULL) {
    return children([
      {
        icon: SvgTerminal,
        status,
        content,
        supportsCollapsible: true,
        alwaysCollapsible: true,
      },
    ]);
  }

  // Compact mode: wrap content in FadeDiv
  return children([
    {
      icon: SvgTerminal,
      status,
      supportsCollapsible: true,
      alwaysCollapsible: true,
      content: (
        <FadingEdgeContainer
          direction="bottom"
          className="max-h-24 overflow-hidden"
        >
          {content}
        </FadingEdgeContainer>
      ),
    },
  ]);
};
