import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Coins, Film, Plus, ShoppingCart } from "lucide-react";

export const Route = createFileRoute("/dashboard/")({
  component: OverviewPage,
});

interface TaskInfo {
  id: string;
  status: "queued" | "processing" | "succeeded" | "failed";
  modelCode: string;
  prompt: string;
  creditsReserved: number;
  createdAt: number;
}

const STATUS_STYLES: Record<TaskInfo["status"], string> = {
  queued: "bg-yellow-100 text-yellow-800",
  processing: "bg-blue-100 text-blue-800",
  succeeded: "bg-green-100 text-green-800",
  failed: "bg-red-100 text-red-800",
};

function OverviewPage() {
  const { session } = Route.useRouteContext();
  const [balance, setBalance] = useState<number | null>(null);
  const [tasks, setTasks] = useState<TaskInfo[]>([]);

  useEffect(() => {
    fetch("/api/credits/balance")
      .then((res) => (res.ok ? (res.json() as Promise<{ balance?: number }>) : null))
      .then((data) => {
        if (typeof data?.balance === "number") setBalance(data.balance);
      })
      .catch(() => {});
    fetch("/api/video/tasks")
      .then((res) =>
        res.ok
          ? (res.json() as Promise<{ tasks?: TaskInfo[] }>)
          : { tasks: [] as TaskInfo[] },
      )
      .then((data) => setTasks(data.tasks ?? []))
      .catch(() => {});
  }, []);

  const active = tasks.filter(
    (t) => t.status === "queued" || t.status === "processing",
  ).length;
  const succeeded = tasks.filter((t) => t.status === "succeeded").length;
  const failed = tasks.filter((t) => t.status === "failed").length;
  const recent = tasks.slice(0, 5);

  const displayName =
    session?.user?.name || session?.user?.email || "there";

  return (
    <main className="flex-1 mx-auto w-full max-w-5xl p-8 space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold">Welcome back, {displayName}</h1>
          <p className="text-sm text-gray-500 mt-1">
            Here's what's happening with your videos.
          </p>
        </div>
        <div className="flex gap-2">
          <Button asChild>
            <Link to="/dashboard/video">
              <Plus className="size-4" />
              New video
            </Link>
          </Button>
          <Button variant="outline" asChild>
            <Link to="/dashboard/billing">
              <ShoppingCart className="size-4" />
              Buy credits
            </Link>
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-1.5">
              <Coins className="size-4" /> Credits
            </CardDescription>
            <CardTitle className="text-3xl tabular-nums">
              {balance ?? "…"}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-1.5">
              <Film className="size-4" /> In progress
            </CardDescription>
            <CardTitle className="text-3xl tabular-nums">{active}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Succeeded</CardDescription>
            <CardTitle className="text-3xl tabular-nums">
              {succeeded}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Failed</CardDescription>
            <CardTitle className="text-3xl tabular-nums">{failed}</CardTitle>
          </CardHeader>
        </Card>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Recent tasks</CardTitle>
          <Button variant="outline" size="sm" asChild>
            <Link to="/dashboard/video">View all</Link>
          </Button>
        </CardHeader>
        <CardContent>
          {recent.length === 0 ? (
            <div className="text-center py-10 space-y-3">
              <p className="text-gray-500">
                No videos yet — generate your first one.
              </p>
              <Button asChild>
                <Link to="/dashboard/video">
                  <Plus className="size-4" />
                  New video
                </Link>
              </Button>
            </div>
          ) : (
            <div className="divide-y">
              {recent.map((t) => (
                <div
                  key={t.id}
                  className="flex items-center gap-3 py-3 text-sm"
                >
                  <span
                    className={`px-2 py-0.5 rounded-full text-xs font-medium shrink-0 ${STATUS_STYLES[t.status]}`}
                  >
                    {t.status}
                  </span>
                  <span className="flex-1 truncate">{t.prompt}</span>
                  <span className="text-gray-500 hidden sm:inline">
                    {t.modelCode}
                  </span>
                  <span className="text-gray-400 tabular-nums shrink-0">
                    {new Date(t.createdAt).toLocaleDateString()}
                  </span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
