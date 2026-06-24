/** Vite's `?worker` import: default export is a zero-arg Worker constructor. */
declare module "*?worker" {
  const WorkerCtor: { new (): Worker };
  export default WorkerCtor;
}
