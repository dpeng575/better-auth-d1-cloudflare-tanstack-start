import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";

export const Route = createFileRoute("/dashboard/billing")({
  beforeLoad: ({ context }) => {
    if (!context.session) {
      throw redirect({ to: "/" });
    }
  },
  component: BillingPage,
});

interface PlanInfo {
  code: string;
  name: string;
  amountCents: number;
  currency: string;
  credits: number;
  description: string;
}

interface OrderInfo {
  orderNo: string;
  planCode: string;
  amountCents: number;
  status: string;
  createdAt: number;
}

function BillingPage() {
  const [plans, setPlans] = useState<PlanInfo[]>([]);
  const [balance, setBalance] = useState<number | null>(null);
  const [orders, setOrders] = useState<OrderInfo[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [buying, setBuying] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/billing/plans");
    if (res.ok) {
      const data = (await res.json()) as {
        plans: PlanInfo[];
        balance: number;
      };
      setPlans(data.plans);
      setBalance(data.balance);
    }
    const o = await fetch("/api/billing/orders");
    if (o.ok) {
      const data = (await o.json()) as { orders?: OrderInfo[] };
      setOrders(data.orders ?? []);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const buy = async (planCode: string) => {
    setBuying(planCode);
    setMessage(null);
    try {
      const res = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planCode }),
      });
      const data = (await res.json()) as {
        checkoutUrl?: string;
        error?: { message?: string };
      };
      if (!res.ok || !data.checkoutUrl) {
        setMessage(data.error?.message ?? "Checkout failed");
        return;
      }
      // Waffo cashier — redirect synchronously from the click handler.
      window.location.href = data.checkoutUrl;
    } finally {
      setBuying(null);
    }
  };

  return (
    <div className="flex flex-col min-h-screen">
      <main className="flex-1 flex flex-col items-center p-8">
        <div className="w-full max-w-3xl space-y-6">
          <div className="text-center">
            <h1 className="text-3xl font-bold">Billing</h1>
            <p className="text-sm text-gray-500 mt-2">
              Balance:{" "}
              <span className="font-semibold">{balance ?? "…"}</span> credits
            </p>
          </div>

          {message && (
            <p className="text-center text-sm text-red-600">{message}</p>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {plans.map((p) => (
              <Card key={p.code}>
                <CardHeader>
                  <CardTitle className="text-xl">{p.name}</CardTitle>
                  <CardDescription>{p.description}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  <p className="text-3xl font-bold">
                    ${(p.amountCents / 100).toFixed(2)}
                  </p>
                  <Button
                    className="w-full"
                    disabled={buying !== null}
                    onClick={() => buy(p.code)}
                  >
                    {buying === p.code ? "Redirecting..." : "Buy credits"}
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Orders</CardTitle>
            </CardHeader>
            <CardContent>
              {orders.length === 0 ? (
                <p className="text-center text-gray-500 py-6">No orders yet.</p>
              ) : (
                <div className="space-y-2">
                  {orders.map((o) => (
                    <div
                      key={o.orderNo}
                      className="flex items-center justify-between p-3 border rounded-lg text-sm"
                    >
                      <span className="font-mono text-xs truncate">
                        {o.orderNo}
                      </span>
                      <span className="flex items-center gap-2">
                        ${(o.amountCents / 100).toFixed(2)}
                        <span
                          className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                            o.status === "paid"
                              ? "bg-green-100 text-green-800"
                              : o.status === "pending"
                                ? "bg-yellow-100 text-yellow-800"
                                : "bg-red-100 text-red-800"
                          }`}
                        >
                          {o.status}
                        </span>
                      </span>
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
