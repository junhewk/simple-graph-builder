/** Markdown bundled as text by esbuild's `.md` loader (the changelog, for release notes). */
declare module '*.md' {
	const text: string;
	export default text;
}
