import { useEffect, useState, type Dispatch, type SetStateAction } from "react";

interface Options {
  /** Reject parsed values that fail this check; falls back to `initial`. */
  validate?: (n: number) => boolean;
  /** Default: `String(n)`. Use to control precision for floats. */
  serialize?: (n: number) => string;
  /** Default: `Number(s)`. Use parseInt for integer-only stores. */
  parse?: (s: string) => number;
}

/**
 * useState that mirrors itself into localStorage. Init reads the key
 * once; every change writes back. Survives SSR / private mode (becomes
 * a plain useState). Quota errors are swallowed.
 */
export function usePersistedNumber(
  key: string,
  initial: number,
  options?: Options,
): [number, Dispatch<SetStateAction<number>>] {
  const validate = options?.validate ?? (() => true);
  const serialize = options?.serialize ?? String;
  const parse = options?.parse ?? Number;
  const [value, setValue] = useState<number>(() => {
    if (typeof localStorage === "undefined") return initial;
    const raw = localStorage.getItem(key);
    if (raw == null) return initial;
    const n = parse(raw);
    return Number.isFinite(n) && validate(n) ? n : initial;
  });
  useEffect(() => {
    if (typeof localStorage === "undefined") return;
    try { localStorage.setItem(key, serialize(value)); } catch { /* quota — ignore */ }
    // serialize identity changes per render; only re-fire on key/value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, value]);
  return [value, setValue];
}
