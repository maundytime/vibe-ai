import {
	Tldraw,
	TldrawEditorConfig,
	toolbarItem,
	uniqueId,
	useApp,
	useToasts,
} from '@tldraw/tldraw'
import { useEffect, useState } from 'react'
import { track } from 'signia-react'
import { SDImageTool, SDImageUtil } from './SDImage'
import './styles.css'
import tips from './tips.json'

const customTldrawConfig = new TldrawEditorConfig({
	tools: [SDImageTool],
	shapes: {
		sdimage: {
			util: SDImageUtil,
		},
	},
})

export default function Vibe() {
	return (
		<div className="tldraw__editor">
			<Tldraw
				persistenceKey="vibe"
				config={customTldrawConfig}
				autoFocus
				overrides={{
					tools(app, tools) {
						// In order for our custom tool to show up in the UI...
						// We need to add it to the tools list. This "toolItem"
						// has information about its icon, label, keyboard shortcut,
						// and what to do when it's selected.
						tools.sdimage = {
							id: 'sdimage',
							icon: 'geo-star',
							kbd: 's',
							label: 'SDImage' as any,
							readonlyOk: false,
							onSelect: () => {
								app.setSelectedTool('sdimage')
							},
						}
						return tools
					},
					toolbar(app, toolbar, { tools }) {
						// The toolbar is an array of items. We can add it to the
						// end of the array or splice it in, then return the array.
						toolbar.splice(4, 0, toolbarItem(tools.sdimage))
						return toolbar
					},
					// keyboardShortcutsMenu(app, keyboardShortcutsMenu, { tools }) {
					// 	// Same for the keyboard shortcuts menu, but this menu contains
					// 	// both items and groups. We want to find the "Tools" group and
					// 	// add it to that before returning the array.
					// 	const toolsGroup = keyboardShortcutsMenu.find(
					// 		(group) => group.id === 'shortcuts-dialog.tools'
					// 	) as MenuGroup
					// 	toolsGroup.children.push(menuItem(tools.sdimage))
					// 	return keyboardShortcutsMenu
					// },
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
	const app = useApp()
	const [model, setModel] = useState<string>()
	const [models, setModels] = useState([])
	const [loras, setLoras] = useState([])

	useEffect(() => {
		fetch(app.sdURL + '/sdapi/v1/sd-models', {
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
		fetch(app.sdURL + '/sdapi/v1/loras', {
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
	}, [app.sdURL])

	useEffect(() => {
		fetch(app.sdURL + '/sdapi/v1/options', {
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
	}, [models, app.sdURL])

	const triggerLora = (value: string) => {
		const selectedShapes = app.selectedShapes
		if (selectedShapes.length === 1 && selectedShapes[0].type === 'text') {
			let { text } = selectedShapes[0].props as any
			const re = new RegExp(`[ ]?<lora:${value}[\\s\\S]*?>`, 'g')
			if (text.match(re)) {
				text = text.replace(re, '')
			} else {
				text = text + ' <lora:' + value + ':1>'
			}
			app.updateShapes([
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
		fetch(app.sdURL + '/sdapi/v1/options', {
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
		if (!app.renderingShapes.length) {
			app.createShapes(tips.shapes as any)
			app.zoomToContent()
		}
	}, [app])

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
					app.sdParameter = e.target.value
				}}
				value={app.sdParameter}
			/>
			<input
				onKeyDownCapture={(e) => {
					if (e.key === 'Enter') {
						;(e.target as HTMLElement).blur()
					}
				}}
				className="custom-input"
				onChange={(e) => {
					app.sdcnParameter = e.target.value
				}}
				value={app.sdcnParameter}
			/>
			{app.isDev && (
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
