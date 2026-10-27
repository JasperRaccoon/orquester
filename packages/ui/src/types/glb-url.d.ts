/** Vite's `?url` import of a GLB device model: default export is the emitted asset's URL. */
declare module "*.glb?url" {
  const url: string;
  export default url;
}
