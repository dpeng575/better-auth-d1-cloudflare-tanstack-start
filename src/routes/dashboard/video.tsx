import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import authClient from "@/auth/authClient";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";

export const Route = createFileRoute("/dashboard/video")({
  beforeLoad: ({ context }) => {
    if (!context.session) {
      throw redirect({ to: "/" });
    }
  },
  component: VideoPage,
});

interface ModelInfo {
  code: string;
  name: string;
  creditCost: number;
  maxDurationSec: number | null;
}

interface TaskInfo {
  id: string;
  status: "queued" | "processing" | "succeeded" | "failed";
  modelCode: string;
  prompt: string;
  creditsReserved: number;
  errorCode: string | null;
  errorMessage: string | null;
  result: { r2Key: string | null; meta: Record<string, unknown> } | null;
  createdAt: number;
}

function VideoPage() {
  const { publicURL } = Route.useRouteContext();
  const api = authClient(publicURL);
  void api; // auth cookie is sent along with same-origin fetches below

  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelCode, setModelCode] = useState("");
  const [prompt, setPrompt] = useState("");
  const [tasks, setTasks] = useState<TaskInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const pollTimer = useRef<number | null>(null);

  const loadModels = useCallback(async () => {
    const res = await fetch("/api/video/models");
    if (!res.ok) return;
    const data = (await res.json()) as { models?: ModelInfo[] };
    setModels(data.models ?? []);
    if (data.models?.length && !modelCode) setModelCode(data.models[0].code);
  }, [modelCode]);

  const loadTasks = useCallback(async () => {
    const res = await fetch("/api/video/tasks");
    if (!res.ok) return;
    const data = (await res.json()) as { tasks?: TaskInfo[] };
    setTasks(data.tasks ?? []);
    return data.tasks as TaskInfo[];
  }, []);

  // Boot: load models + tasks, then poll while anything is in flight.
  useEffect(() => {
    loadModels();
    loadTasks();
  }, [loadModels, loadTasks]);

  useEffect(() => {
    const active = tasks.some(
      (t) => t.status === "queued" || t.status === "processing",
    );
    if (!active) {
      if (pollTimer.current) {
        window.clearInterval(pollTimer.current);
        pollTimer.current = null;
      }
      return;
    }
    if (pollTimer.current) return;
    pollTimer.current = window.setInterval(async () => {
      const next = await loadTasks();
      const stillActive = (next ?? tasks).some(
        (t) => t.status === "queued" || t.status === "processing",
      );
      if (!stillActive && pollTimer.current) {
        window.clearInterval(pollTimer.current);
        pollTimer.current = null;
      }
    }, 3000);
    return () => {
      if (pollTimer.current) {
        window.clearInterval(pollTimer.current);
        pollTimer.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks, loadTasks]);

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      // clientKey: dedupe retries of THIS submission (refresh double-click).
      const clientKey = `web-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const res = await fetch("/api/video/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelCode, prompt, clientKey }),
      });
      const data = (await res.json()) as { error?: { message?: string } };
      if (!res.ok) {
        setError(data?.error?.message ?? "Submit failed");
        return;
      }
      setPrompt("");
      await loadTasks();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex flex-col min-h-screen">
      <main className="flex-1 flex flex-col items-center p-8">
        <div className="w-full max-w-3xl space-y-6">
          <div className="text-center">
            <h1 className="text-3xl font-bold">AI Video Studio</h1>
            <p className="text-sm text-gray-500 mt-2">
              Generate videos with credits
            </p>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>New Generation</CardTitle>
              <CardDescription>
                Credits are reserved when you submit and refunded if the
                generation fails.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <Label htmlFor="model" className="mb-2 block">
                  Model
                </Label>
                <select
                  id="model"
                  className="w-full rounded-md border border-gray-300 p-2"
                  value={modelCode}
                  onChange={(e) => setModelCode(e.target.value)}
                >
                  {models.map((m) => (
                    <option key={m.code} value={m.code}>
                      {m.name} — {m.creditCost} credits
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <Label htmlFor="prompt" className="mb-2 block">
                  Prompt
                </Label>
                <textarea
                  id="prompt"
                  className="w-full rounded-md border border-gray-300 p-2 min-h-24"
                  placeholder="Describe the video you want..."
                  value={prompt}
                  maxLength={2000}
                  onChange={(e) => setPrompt(e.target.value)}
                />
                <p className="text-xs text-gray-500 mt-1">
                  Tip: use "mock-pro" with the word "fail" in the prompt to see
                  the refund flow.
                </p>
              </div>
              {error && <p className="text-sm text-red-600">{error}</p>}
              <Button
                onClick={submit}
                disabled={submitting || !modelCode || prompt.trim().length === 0}
                className="w-full"
              >
                {submitting ? "Submitting..." : "Generate"}
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle>Your Tasks</CardTitle>
              <Button variant="outline" size="sm" onClick={() => loadTasks()}>
                Refresh
              </Button>
            </CardHeader>
            <CardContent>
              {tasks.length === 0 ? (
                <p className="text-center text-gray-500 py-8">
                  No tasks yet — submit your first generation above.
                </p>
              ) : (
                <div className="space-y-2">
                  {tasks.map((t) => (
                    <div
                      key={t.id}
                      className="p-3 border rounded-lg space-y-2"
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex-1 min-w-0">
                          <p className="font-medium truncate">{t.prompt}</p>
                          <div className="flex flex-wrap items-center gap-2 mt-1 text-sm text-gray-500">
                            <StatusBadge status={t.status} />
                            <span>{t.modelCode}</span>
                            <span>•</span>
                            <span>{t.creditsReserved} credits</span>
                            {t.errorMessage && (
                              <span className="text-red-600">
                                ({t.errorMessage})
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                      {t.status === "succeeded" && t.result && (
                        <ResultMedia taskId={t.id} result={t.result} />
                      )}
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </main>
    </div>
  );
}

function StatusBadge({ status }: { status: TaskInfo["status"] }) {
  const styles: Record<TaskInfo["status"], string> = {
    queued: "bg-yellow-100 text-yellow-800",
    processing: "bg-blue-100 text-blue-800",
    succeeded: "bg-green-100 text-green-800",
    failed: "bg-red-100 text-red-800",
  };
  return (
    <span
      className={`px-2 py-0.5 rounded-full text-xs font-medium ${styles[status]}`}
    >
      {status}
    </span>
  );
}

function ResultMedia({
  taskId,
  result,
}: {
  taskId: string;
  result: { r2Key: string | null; meta: Record<string, unknown> };
}) {
  const downloadUrl = `/api/video/tasks/${taskId}/download`;

  if (!result.r2Key) {
    return (
      <p className="text-xs text-gray-500">
        Generation finished (no stored media).
      </p>
    );
  }

  if (result.meta?.mock) {
    return (
      <div className="flex items-center gap-3 p-3 bg-gray-50 rounded-md">
        <div className="flex-1">
          <p className="text-sm font-medium">Mock video ready</p>
          <p className="text-xs text-gray-500">
            Stored in R2 — downloads as a text placeholder.
          </p>
        </div>
        <a href={downloadUrl} download>
          <Button variant="outline" size="sm">
            Download
          </Button>
        </a>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <video
        controls
        preload="metadata"
        src={downloadUrl}
        className="w-full rounded-md max-h-72 bg-black"
      />
      <a href={downloadUrl} download>
        <Button variant="outline" size="sm">
          Download
        </Button>
      </a>
    </div>
  );
}
