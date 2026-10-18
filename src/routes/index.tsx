import authClient from "@/auth/authClient";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

export const Route = createFileRoute("/")({
  beforeLoad: ({ context }) => {
    if (context?.session) {
      throw redirect({ to: "/dashboard" });
    }
  },
  component: App,
});

const RESEND_COOLDOWN_SECONDS = 60;

function GoogleIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="size-4">
      <path
        fill="#4285F4"
        d="M23.49 12.27c0-.79-.07-1.54-.19-2.27H12v4.51h6.47a5.57 5.57 0 0 1-2.4 3.58v3h3.86c2.26-2.09 3.56-5.17 3.56-8.82z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.86-3c-1.08.72-2.45 1.16-4.07 1.16-3.13 0-5.78-2.11-6.73-4.96H1.29v3.09A11.99 11.99 0 0 0 12 24z"
      />
      <path
        fill="#FBBC05"
        d="M5.27 14.29A7.2 7.2 0 0 1 4.89 12c0-.8.14-1.57.38-2.29V6.62H1.29a12 12 0 0 0 0 10.76l3.98-3.09z"
      />
      <path
        fill="#EA4335"
        d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42A11.98 11.98 0 0 0 12 0 11.99 11.99 0 0 0 1.29 6.62l3.98 3.09C6.22 6.86 8.87 4.75 12 4.75z"
      />
    </svg>
  );
}

function App() {
  const [isAuthActionInProgress, setIsAuthActionInProgress] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<"email" | "otp">("email");
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [cooldown, setCooldown] = useState(0);
  const cooldownTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const { publicURL } = Route.useRouteContext();

  useEffect(() => {
    return () => {
      if (cooldownTimer.current) clearInterval(cooldownTimer.current);
    };
  }, []);

  const startCooldown = () => {
    setCooldown(RESEND_COOLDOWN_SECONDS);
    cooldownTimer.current = setInterval(() => {
      setCooldown((remaining) => {
        if (remaining <= 1) {
          if (cooldownTimer.current) clearInterval(cooldownTimer.current);
          return 0;
        }
        return remaining - 1;
      });
    }, 1000);
  };

  const handleSendCode = async () => {
    const trimmed = email.trim();
    if (!/^\S+@\S+\.\S+$/.test(trimmed)) {
      setError("Please enter a valid email address.");
      return;
    }
    setIsAuthActionInProgress(true);
    setError(null);
    try {
      const result = await authClient(publicURL).emailOtp.sendVerificationOtp({
        email: trimmed,
        type: "sign-in",
      });
      if (result.error) {
        setError(result.error.message || "Failed to send the code.");
      } else {
        setStep("otp");
        startCooldown();
      }
    } catch (e: any) {
      setError(`An unexpected error occurred: ${e.message}`);
    } finally {
      setIsAuthActionInProgress(false);
    }
  };

  const handleVerifyCode = async () => {
    const trimmedOtp = otp.trim();
    if (trimmedOtp.length !== 6) {
      setError("Please enter the 6-digit code from your email.");
      return;
    }
    setIsAuthActionInProgress(true);
    setError(null);
    try {
      const result = await authClient(publicURL).signIn.emailOtp({
        email: email.trim(),
        otp: trimmedOtp,
      });
      if (result.error) {
        setError(result.error.message || "Login failed.");
      } else {
        // Login succeeded - middleware will handle redirect to dashboard
        window.location.reload();
      }
    } catch (e: any) {
      setError(`An unexpected error occurred: ${e.message}`);
    } finally {
      setIsAuthActionInProgress(false);
    }
  };

  const handleGoogleLogin = async () => {
    setIsAuthActionInProgress(true);
    setError(null);
    try {
      // better-auth redirects the browser to Google's consent page,
      // then back to callbackURL after a successful sign-in.
      const result = await authClient(publicURL).signIn.social({
        provider: "google",
        callbackURL: "/dashboard",
      });
      if (result.error) {
        setError(result.error.message || "Google login failed.");
        setIsAuthActionInProgress(false);
      }
    } catch (e: any) {
      setError(`An unexpected error occurred: ${e.message}`);
      setIsAuthActionInProgress(false);
    }
  };

  const handleAnonymousLogin = async () => {
    setIsAuthActionInProgress(true);
    setError(null);
    try {
      const result = await authClient(publicURL).signIn.anonymous();
      if (result.error) {
        setError(result.error.message || "Anonymous login failed.");
      } else {
        window.location.reload();
      }
    } catch (e: any) {
      setError(`An unexpected error occurred: ${e.message}`);
    } finally {
      setIsAuthActionInProgress(false);
    }
  };

  return (
    <div className="flex items-center justify-center min-h-screen p-8 font-[family-name:var(--font-geist-sans)]">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-2xl">Login</CardTitle>
          <CardDescription>
            We'll email you a 6-digit login code. No password needed.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {step === "email" ? (
            <div className="grid gap-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleSendCode()}
                disabled={isAuthActionInProgress}
                autoFocus
              />
            </div>
          ) : (
            <div className="grid gap-2">
              <Label htmlFor="otp">
                Code sent to {email.trim()}{" "}
                <button
                  type="button"
                  className="text-primary underline underline-offset-2"
                  onClick={() => setStep("email")}
                  disabled={isAuthActionInProgress}
                >
                  Change
                </button>
              </Label>
              <Input
                id="otp"
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="6-digit code"
                maxLength={6}
                value={otp}
                onChange={(e) =>
                  setOtp(e.target.value.replace(/\D/g, "").slice(0, 6))
                }
                onKeyDown={(e) => e.key === "Enter" && handleVerifyCode()}
                disabled={isAuthActionInProgress}
                autoFocus
              />
            </div>
          )}
          {error && <p className="text-sm text-red-600">{error}</p>}
        </CardContent>
        <CardFooter className="flex flex-col gap-3">
          {step === "email" ? (
            <Button
              onClick={handleSendCode}
              className="w-full"
              disabled={isAuthActionInProgress}
            >
              {isAuthActionInProgress ? "Sending..." : "Send Login Code"}
            </Button>
          ) : (
            <>
              <Button
                onClick={handleVerifyCode}
                className="w-full"
                disabled={isAuthActionInProgress}
              >
                {isAuthActionInProgress ? "Verifying..." : "Verify & Login"}
              </Button>
              <Button
                onClick={handleSendCode}
                variant="outline"
                className="w-full"
                disabled={isAuthActionInProgress || cooldown > 0}
              >
                {cooldown > 0 ? `Resend in ${cooldown}s` : "Resend Code"}
              </Button>
            </>
          )}
          <Button
            onClick={handleGoogleLogin}
            variant="outline"
            className="w-full"
            disabled={isAuthActionInProgress}
          >
            <GoogleIcon />
            Continue with Google
          </Button>
          <Button
            onClick={handleAnonymousLogin}
            variant="ghost"
            className="w-full text-muted-foreground"
            disabled={isAuthActionInProgress}
          >
            Continue without an account
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}
