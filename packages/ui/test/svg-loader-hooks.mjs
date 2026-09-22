const SVG = /\.svg(\?react|\?url)?$/;
export async function resolve(specifier, context, next) {
  if (SVG.test(specifier)) {
    return { url: `orq-svg:${specifier}`, shortCircuit: true };
  }
  return next(specifier, context);
}
export async function load(url, context, next) {
  if (url.startsWith("orq-svg:")) {
    return {
      format: "module",
      shortCircuit: true,
      source:
        "export default function SvgStub() { return null; }\n" +
        "export const ReactComponent = SvgStub;\n"
    };
  }
  return next(url, context);
}
