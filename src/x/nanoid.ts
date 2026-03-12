// Avoid extra deps; good enough for request correlation.
export function nanoid(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

