import packageInfo from "@/package.json";

export const ALPHA_VERSION = packageInfo.version;
export const ALPHA_DISPLAY_VERSION = packageInfo.version.replace(/\.0$/, "");

