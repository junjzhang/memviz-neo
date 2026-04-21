/**
 * lower_bound on a sorted Float64Array of event timestamps — returns the
 * smallest index i such that events[i] >= t. The "event" X-axis mode maps
 * each μs-offset to its position in this array, collapsing idle gaps.
 */
export function eventIdxAt(events: Float64Array, t: number): number {
  let lo = 0, hi = events.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (events[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
