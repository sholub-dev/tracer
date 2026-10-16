/** Runs tasks one at a time in call order; a failed task does not stop the ones after it. */
export function serialQueue() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task);
    tail = run.catch(() => {});
    return run;
  };
}
