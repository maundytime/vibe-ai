import { SolidStylePolygon } from '@tldraw/editor/src/lib/app/shapeutils/TLGeoUtil/components/SolidStylePolygon'
import { TextLabel } from '@tldraw/editor/src/lib/app/shapeutils/shared/TextLabel'
import { resizeBox } from '@tldraw/editor/src/lib/app/shapeutils/shared/resizeBox'
import { SD_MIN } from '@tldraw/editor/src/lib/constants'
import { toDomPrecision } from '@tldraw/primitives'
import {
	OnEditEndHandler,
	OnResizeHandler,
	SDImageShape,
	SDImageShapeProps,
	SVGContainer,
	TLBoxTool,
	TLBoxUtil,
	TLStyleType,
} from '@tldraw/tldraw'

export class SDImageTool extends TLBoxTool {
	static override id = 'sdimage'
	static override initial = 'idle'
	override shapeType = 'sdimage'
	override styles = [] as TLStyleType[]
}

export class SDImageUtil extends TLBoxUtil<SDImageShape> {
	static override type = 'sdimage'
	override isAspectRatioLocked = (_shape: SDImageShape) => false
	override canResize = (_shape: SDImageShape) => true
	override canBind = (_shape: SDImageShape) => true
	override canEdit = () => true

	override defaultProps(): SDImageShape['props'] {
		return {
			w: SD_MIN,
			h: SD_MIN,
			text: `${SD_MIN} x ${SD_MIN}`,
		}
	}

	override onEditEnd?: OnEditEndHandler<SDImageShape> | undefined = (shape) => {
		this.app.updateShapes([
			{
				id: shape.id,
				type: 'sdimage',
				props: this.getSize(shape),
			},
		])
	}

	override onResize: OnResizeHandler<any> = (shape, info) => {
		const w = Math.abs(shape.props.w * info.scaleX).toFixed()
		const h = Math.abs(shape.props.h * info.scaleY).toFixed()
		this.app.updateShapes([
			{
				id: shape.id,
				type: 'text',
				props: {
					text: `${w} x ${h}`,
				},
			},
		])
		return resizeBox(shape, info)
	}

	getSize = (shape: SDImageShape): SDImageShapeProps => {
		const single = parseInt(shape.props.text)
		const matches = shape.props.text.match(/([\d]+)[^\d]+([\d]+)/)
		if (matches?.length === 3) {
			const w = parseInt(matches[1])
			const h = parseInt(matches[2])
			const text = `${w} x ${h}`
			return { w, h, text }
		} else if (single) {
			const w = single
			const h = single
			const text = `${w} x ${h}`
			return { w, h, text }
		} else {
			const w = Math.abs(shape.props.w)
			const h = Math.abs(shape.props.h)
			const text = `${w} x ${h}`
			return { w, h, text }
		}
	}

	render(shape: SDImageShape) {
		const { text } = shape.props
		const { id } = shape
		const size = 'm'
		const strokeWidth = this.app.getStrokeWidth(size)
		const outline = this.outline(shape)

		return (
			<>
				<SVGContainer id={id} style={{ pointerEvents: 'auto' }}>
					<SolidStylePolygon
						fill={'none'}
						color={'black'}
						strokeWidth={strokeWidth}
						outline={outline}
					/>
				</SVGContainer>
				<TextLabel
					id={id}
					type={'geo'}
					font={'draw'}
					size={size}
					align={'middle'}
					verticalAlign={'middle'}
					text={text}
					labelColor={this.app.getCssColor('black')}
					wrap
				/>
			</>
		)
	}

	indicator(shape: SDImageShape) {
		return <rect width={toDomPrecision(shape.props.w)} height={toDomPrecision(shape.props.h)} />
	}
}
