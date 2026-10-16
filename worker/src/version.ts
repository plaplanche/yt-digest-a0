import pkg from "../package.json";

/** The version of worker/package.json, answered by `/health` and logged by `service.started`. */
export const VERSION: string = pkg.version;
