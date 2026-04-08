import { cn } from "@/lib/utils";

export function Skeleton({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("animate-pulse rounded-md", className)}
      style={{ background: "#eee8dd" }}
      {...props}
    />
  );
}

/** Card-shaped skeleton for member/staff cards */
export function SkeletonCard() {
  return (
    <div
      className="rounded-lg p-4 space-y-3 border"
      style={{ borderColor: "#ddd5c8" }}
    >
      <div className="flex items-center gap-3">
        <Skeleton className="w-10 h-10 rounded-full" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-3 w-16" />
        </div>
      </div>
      <Skeleton className="h-3 w-32" />
    </div>
  );
}
