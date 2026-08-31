import { useLogTail } from "@/hooks/useLogTail";

/** Values resolved when this consumer is loaded after the focus-refresh suite. */
export const consumerUseLogTail = useLogTail;
export const consumerFetch = globalThis.fetch;
