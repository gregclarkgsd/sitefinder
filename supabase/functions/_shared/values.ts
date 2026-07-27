export function safeBoolean(value: unknown) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  return ['true', '1', 'yes'].includes(String(value || '').trim().toLowerCase());
}

export function safeBooleanWithFallback(primary: unknown, fallback: unknown) {
  if (primary !== null && primary !== undefined && primary !== '') {
    return safeBoolean(primary);
  }
  return safeBoolean(fallback);
}
