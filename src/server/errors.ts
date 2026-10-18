export class AppError extends Error {
  constructor(public status: number, message: string, public code = "VALIDATION_ERROR") { super(message); this.name = "AppError"; }
}
export function requireCondition(condition: unknown, status: number, message: string): asserts condition {
  if (!condition) throw new AppError(status, message);
}

