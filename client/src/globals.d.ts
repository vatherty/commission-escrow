declare module "*.css";

/* The client's types come from the server's action registry (type-only
   import), which pulls server modules into this program. Those modules
   use Bun's ImportMeta.dir; declare it here so the client typecheck
   doesn't need the full Bun type package. */
interface ImportMeta {
  dir: string;
}
