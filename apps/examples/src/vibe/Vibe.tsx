import { SdimageShape, Tldraw, toolbarItem, uniqueId, useEditor, useToasts } from '@tldraw/tldraw'
import { useEffect, useState } from 'react'
import { track } from 'signia-react'
import './styles.css'
import tips from './tips.json'

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
	const { addToast, removeToast } = useToasts()
	const editor = useEditor()
	const [model, setModel] = useState<string>()
	const [models, setModels] = useState([])
	const [loras, setLoras] = useState([])

	useEffect(() => {
		fetch(editor.sdURL + '/sdapi/v1/sd-models', {
			method: 'GET',
			headers: { 'Content-Type': 'application/json' },
		})
			.then((response) => response.json())
			.then((data) => {
				setModels(data.map((e: any) => e.model_name))
			})
			.catch((error) => {
				console.error(error)
			})
		fetch(editor.sdURL + '/sdapi/v1/loras', {
			method: 'GET',
			headers: { 'Content-Type': 'application/json' },
		})
			.then((response) => response.json())
			.then((data) => {
				setLoras(data.map((e: any) => e.name))
			})
			.catch((error) => {
				console.error(error)
			})
	}, [editor.sdURL])

	useEffect(() => {
		fetch(editor.sdURL + '/sdapi/v1/options', {
			method: 'GET',
			headers: { 'Content-Type': 'application/json' },
		})
			.then((response) => response.json())
			.then((data) => {
				const currentModel: string = data['sd_model_checkpoint']
				for (const model of models) {
					if (currentModel.startsWith(model)) {
						setModel(model)
						break
					}
				}
			})
			.catch((error) => {
				console.error(error)
			})
	}, [models, editor.sdURL])

	const triggerLora = (value: string) => {
		const selectedShapes = editor.selectedShapes
		if (selectedShapes.length === 1 && selectedShapes[0].type === 'text') {
			let { text } = selectedShapes[0].props as any
			const re = new RegExp(`[ ]?<lora:${value}[\\s\\S]*?>`, 'g')
			if (text.match(re)) {
				text = text.replace(re, '')
			} else {
				text = text + ' <lora:' + value + ':1>'
			}
			editor.updateShapes([
				{
					id: selectedShapes[0].id,
					type: 'text',
					props: {
						text,
					},
				},
			])
		}
	}

	const switchModel = (value: string) => {
		const toastId1 = uniqueId()
		addToast({
			id: toastId1,
			title: 'switching...',
			description: value,
			keepOpen: true,
		})
		fetch(editor.sdURL + '/sdapi/v1/options', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				sd_model_checkpoint: value,
			}),
		})
			.then((response) => response.json())
			.then((data) => {
				removeToast(toastId1)
				const toastId2 = uniqueId()
				addToast({
					id: toastId2,
					title: 'switched',
					description: data,
					keepOpen: false,
				})
				setModel(value)
			})
			.catch((error) => {
				console.error(error)
			})
	}

	useEffect(() => {
		if (!editor.renderingShapes.length) {
			editor.createShapes(tips.shapes as any)
			editor.zoomToContent()
		}
	}, [editor])

	return (
		<div
			style={{
				position: 'absolute',
				top: 48,
				zIndex: 200,
			}}
		>
			<input
				onKeyDownCapture={(e) => {
					if (e.key === 'Enter') {
						;(e.target as HTMLElement).blur()
					}
				}}
				className="custom-input"
				onChange={(e) => {
					editor.sdParameter = e.target.value
				}}
				value={editor.sdParameter}
			/>
			<input
				onKeyDownCapture={(e) => {
					if (e.key === 'Enter') {
						;(e.target as HTMLElement).blur()
					}
				}}
				className="custom-input"
				onChange={(e) => {
					editor.sdcnParameter = e.target.value
				}}
				value={editor.sdcnParameter}
			/>
			{editor.isDev && (
				<div>
					{models.map((e) => (
						<button
							key={e}
							data-isactive={model === e}
							className="custom-button"
							onClick={() => switchModel(e)}
						>
							{e}
						</button>
					))}
				</div>
			)}
			<div>
				{loras.map((e) => (
					<button
						key={e}
						data-isactive={model === e}
						className="custom-button"
						onClick={() => triggerLora(e)}
					>
						{e}
					</button>
				))}
			</div>
		</div>
	)
})
