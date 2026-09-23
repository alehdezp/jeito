const queues = new Map<string, Promise<void>>();

interface Reservation {
  path: string;
  previous: Promise<void>;
  queued: Promise<void>;
  release: () => void;
}

export async function withLocalFileMutationQueues<T>(paths: Iterable<string>, fn: () => Promise<T>): Promise<T> {
  const ordered = [...new Set(paths)].sort((a, b) => a.localeCompare(b));
  const reservations: Reservation[] = [];

  // Reserve every path synchronously and in deterministic order. Competing
  // batches therefore cannot acquire the same paths in opposite orders.
  for (const path of ordered) {
    const previous = queues.get(path) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const queued = previous.then(() => gate, () => gate);
    queues.set(path, queued);
    reservations.push({ path, previous, queued, release });
  }

  try {
    await Promise.all(reservations.map(item => item.previous.catch(() => undefined)));
    return await fn();
  } finally {
    for (const item of [...reservations].reverse()) item.release();
    for (const item of reservations) {
      if (queues.get(item.path) === item.queued) queues.delete(item.path);
    }
  }
}

export async function withLocalFileMutationQueue<T>(path: string, fn: () => Promise<T>): Promise<T> {
  return await withLocalFileMutationQueues([path], fn);
}
