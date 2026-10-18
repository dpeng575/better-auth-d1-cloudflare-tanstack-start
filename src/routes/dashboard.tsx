import authClient from "@/auth/authClient";
import { Button } from "@/components/ui/button";
import { createFileRoute, Outlet, redirect, useRouter, useRouterState, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Clapperboard, Coins, LogOut } from "lucide-react";

export const Route = createFileRoute("/dashboard")({
  beforeLoad: ({ context }) => {
    if (!context.session) {
      throw redirect({ to: "/" });
    }
  },
  component: DashboardLayout,
});

const NAV_ITEMS = [
  { to: "/dashboard", label: "Overview" },
  { to: "/dashboard/video", label: "Generate" },
  { to: "/dashboard/billing", label: "Billing" },
] as const;

function DashboardLayout() {
  const router = useRouter();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { publicURL } = Route.useRouteContext();
  const [balance, setBalance] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/credits/balance")
      .then((res) => (res.ok ? (res.json() as Promise<{ balance?: number }>) : null))
      .then((data) => {
        if (!cancelled && data && typeof data.balance === "number") {
          setBalance(data.balance);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [pathname]);

  const signOut = async () => {
    await authClient(publicURL).signOut();
    router.navigate({ to: "/" });
  };

  return (
    <div className="flex flex-col min-h-screen">
      <header className="sticky top-0 z-10 border-b bg-background/95 backdrop-blur">
        <div className="mx-auto max-w-5xl flex items-center gap-4 px-4 py-3">
          <Link
            to="/dashboard"
            className="flex items-center gap-2 font-semibold"
          >
            <Clapperboard className="size-5" />
            <span className="hidden sm:inline">AI Video</span>
          </Link>

          <nav className="flex items-center gap-1 flex-1">
            {NAV_ITEMS.map((item) => {
              const active =
                item.to === "/dashboard"
                  ? pathname === "/dashboard"
                  : pathname.startsWith(item.to);
              return (
                <Link
                  key={item.to}
                  to={item.to}
                  className={
                    "px-3 py-1.5 rounded-md text-sm transition-colors " +
                    (active
                      ? "bg-muted font-medium"
                      : "text-muted-foreground hover:bg-muted/60")
                  }
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>

          <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <Coins className="size-4" />
            <span className="font-medium text-foreground tabular-nums">
              {balance ?? "…"}
            </span>
            credits
          </span>

          <Button variant="ghost" size="sm" onClick={signOut}>
            <LogOut className="size-4" />
            <span className="hidden sm:inline">Sign out</span>
          </Button>
        </div>
      </header>

      <Outlet />
    </div>
  );
}
