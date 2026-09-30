/** Vite's `?worker&url` import: the URL of the separately bundled worker/worklet script. */
declare module "*?worker&url" {
  const url: string;
  export default url;
}
