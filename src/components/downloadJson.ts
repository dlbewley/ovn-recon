/**
 * Hand the already-fetched payload to the browser as a JSON download —
 * no extra collector round trip (a node snapshot is ~100KB and in memory).
 */
export const downloadJson = (filename: string, payload: unknown): void => {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
};
