// Shared numeric parameter guards. Navigation tools throw these clear errors so
// invalid bounds never silently coerce or produce confusing empty/truncated
// output. Keep messages short and name the parameter.

export function requirePositive(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 1) throw new Error(`${name} must be a finite positive number (>= 1); got ${value}. Omit it for the default or narrow the query instead of raising it.`);
}

export function requireNonNegative(name: string, value: number): void {
  if (value < 0) throw new Error(`${name} must not be negative; got ${value}. Use 0 for none or a positive number.`);
}
