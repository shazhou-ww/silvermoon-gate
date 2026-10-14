import { forwardRef } from "react";
import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: "default" | "outline" | "destructive";
  }
>(({ className = "", variant = "default", type = "button", ...props }, ref) => (
  <button
    ref={ref}
    type={type}
    data-slot="button"
    data-variant={variant}
    className={`button button-${variant} ${className}`}
    {...props}
  />
));
Button.displayName = "Button";

export const Card = forwardRef<HTMLElement, HTMLAttributes<HTMLElement>>(
  ({ className = "", ...props }, ref) => (
    <section
      ref={ref}
      data-slot="card"
      className={`card ${className}`}
      {...props}
    />
  ),
);
Card.displayName = "Card";

export function Alert({ children }: { children: ReactNode }) {
  return (
    <div data-slot="alert" className="alert" role="alert">
      {children}
    </div>
  );
}

export const statusLabels = {
  pending: "等待审批",
  approved: "已批准",
  rejected: "已拒绝",
  withdrawn: "已撤回",
};

export function Badge({ status }: { status: keyof typeof statusLabels }) {
  return (
    <span className={`badge badge-${status}`}>{statusLabels[status]}</span>
  );
}
