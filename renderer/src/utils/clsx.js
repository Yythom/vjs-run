import { clsx as clsxBase } from "clsx";
import { twMerge } from "tailwind-merge";

export function clsx(...inputs) {
  return twMerge(clsxBase(inputs));
}

export default clsx;
