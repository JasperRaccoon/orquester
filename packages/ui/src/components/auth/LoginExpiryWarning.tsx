import { AlertTriangle } from "lucide-react";
import { loginExpiryWarning, type LoginStatus } from "../../lib/login-expiry";
import { cn } from "../../lib/cn";

export function LoginExpiryWarning({ login, now, className }: {
  login: LoginStatus;
  now: number;
  className?: string;
}) {
  const warning = loginExpiryWarning(login, now);
  if (!warning) return null;
  return (
    <span className={cn("flex items-start gap-1 text-xs leading-4 text-warn", className)}>
      <AlertTriangle size={12} className="mt-0.5 shrink-0" aria-hidden />
      <span>{warning}</span>
    </span>
  );
}
