import { defineMigrations } from '@tldraw/store'
import { T } from '@tldraw/validate'
import { ShapeProps, TLBaseShape } from './TLBaseShape'

/** @public */
export type TLSdimageShapeProps = {
	w: number
	h: number
	text: string
}

/** @public */
export type TLSdimageShape = TLBaseShape<'sdimage', TLSdimageShapeProps>

/** @internal */
export const sdimageShapeProps: ShapeProps<TLSdimageShape> = {
	w: T.nonZeroNumber,
	h: T.nonZeroNumber,
	text: T.string,
}

/** @internal */
export const sdimageShapeMigrations = defineMigrations({})
