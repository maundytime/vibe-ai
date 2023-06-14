import path from 'path'
import { defineConfig } from 'vite'

export default defineConfig({
	root: path.join(__dirname, 'src'),
	publicDir: path.join(__dirname, 'public'),
	build: {
		outDir: path.join(__dirname, 'dist'),
		assetsInlineLimit: 0,
	},
	server: {
		port: 5420,
	},
	clearScreen: false,
	optimizeDeps: {
		exclude: ['@tldraw/assets'],
	},
	resolve: {
		alias: {
			'@tldraw/tldraw/editor.css': path.resolve(__dirname, '../../packages/editor/editor.css'),
			'@tldraw/tldraw/ui.css': path.resolve(__dirname, '../../packages/ui/ui.css'),
		},
	},
})
