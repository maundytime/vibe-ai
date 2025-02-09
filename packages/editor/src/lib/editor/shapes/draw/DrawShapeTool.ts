import { TLStyleType } from '@tldraw/tlschema'

import { StateNode } from '../../tools/StateNode'
import { Drawing } from './toolStates/Drawing'
import { Idle } from './toolStates/Idle'

export class DrawShapeTool extends StateNode {
	static override id = 'draw'
	static initial = 'idle'
	static children = () => [Idle, Drawing]

	styles = ['color', 'dash', 'fill', 'size'] as TLStyleType[]
	shapeType = 'draw'

	onExit = () => {
		const drawingState = this.children!['drawing'] as Drawing
		drawingState.initialShape = undefined
	}
}
