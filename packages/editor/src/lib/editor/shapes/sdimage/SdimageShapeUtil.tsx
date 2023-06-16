import { toDomPrecision } from '@tldraw/primitives'
import { TLSdimageShape, TLSdimageShapeProps } from '@tldraw/tlschema'
import { SVGContainer } from '../../../components/SVGContainer'
import { SD_MIN } from '../../../constants'
import { BaseBoxShapeUtil } from '../BaseBoxShapeUtil'
import { TLOnEditEndHandler, TLOnResizeHandler } from '../ShapeUtil'
import { SolidStylePolygon } from '../geo/components/SolidStylePolygon'
import { TextLabel } from '../shared/TextLabel'
import { resizeBox } from '../shared/resizeBox'

/** @public */
export class SdimageShapeUtil extends BaseBoxShapeUtil<TLSdimageShape> {
	static override type = 'sdimage' as const
	override isAspectRatioLocked = (_shape: TLSdimageShape) => true
	override canResize = (_shape: TLSdimageShape) => true
	override canBind = () => true
	override canEdit = () => true

	override defaultProps(): TLSdimageShape['props'] {
		return {
			w: SD_MIN,
			h: SD_MIN,
			text: `${SD_MIN} x ${SD_MIN}`,
		}
	}

	override render(shape: TLSdimageShape) {
		const { text } = shape.props
		const { id } = shape
		const size = 'm'
		const strokeWidth = this.editor.getStrokeWidth(size)
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
					labelColor={this.editor.getCssColor('black')}
					wrap
				/>
			</>
		)
	}

	override onEditEnd?: TLOnEditEndHandler<TLSdimageShape> | undefined = (shape) => {
		this.editor.updateShapes([
			{
				id: shape.id,
				type: 'sdimage',
				props: this.getSize(shape),
			},
		])
	}

	override onResize: TLOnResizeHandler<any> = (shape, info) => {
		const w = Math.abs(shape.props.w * info.scaleX).toFixed()
		const h = w
		// const h = Math.abs(shape.props.h * info.scaleY).toFixed()
		this.editor.updateShapes([
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

	getSize = (shape: TLSdimageShape): TLSdimageShapeProps => {
		const single = parseInt(shape.props.text)
		const matches = shape.props.text.match(/([\d]+)[^\d]+([\d]+)/)
		if (matches?.length === 3) {
			const w = parseInt(matches[1])
			const h = w
			// const h = parseInt(matches[2])
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

	indicator(shape: TLSdimageShape) {
		const bounds = this.bounds(shape)
		return <rect width={toDomPrecision(bounds.width)} height={toDomPrecision(bounds.height)} />
	}
}
