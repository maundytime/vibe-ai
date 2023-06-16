import { SdimageShape, Tldraw, toolbarItem, uniqueId, useEditor, useToasts } from '@tldraw/tldraw'
import { useEffect } from 'react'
import { track } from 'signia-react'
import tips from './dall-e-tips.json'
import './styles.css'

export default function Vibe() {
	return (
		<div className="tldraw__editor">
			<Tldraw
				persistenceKey="vibe"
				autoFocus
				shapes={[SdimageShape]}
				overrides={{
					tools(editor, tools) {
						tools.sdimage = {
							id: 'sdimage',
							icon: 'geo-star',
							label: 'Sdimage' as any,
							kbd: 's',
							readonlyOk: false,
							onSelect: () => {
								editor.setSelectedTool('sdimage')
							},
						}
						return tools
					},
					toolbar(_app, toolbar, { tools }) {
						toolbar.splice(4, 0, toolbarItem(tools.sdimage))
						return toolbar
					},
				}}
			>
				<CustomUi />
			</Tldraw>
		</div>
	)
}

// todo
// 文生图
// 图生文
// 图生图（lasso/outpaint/scribble）

const CustomUi = track(() => {
	const editor = useEditor()
	const { addToast } = useToasts()

	useEffect(() => {
		if (!editor.renderingShapes.length) {
			editor.createAssets(tips.assets as any)
			editor.createShapes(tips.shapes as any)
			editor.zoomToContent()
		}
	}, [editor])

	useEffect(() => {
		editor.addListener('ai-need-text', () => {
			const toastId = uniqueId()
			addToast({
				id: toastId,
				title: 'Neet Text',
				description: 'Add text into prompt tree.',
			})
		})
		return () => {
			editor.removeListener('ai-need-text')
		}
	}, [addToast, editor])

	return null
})
