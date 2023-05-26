import { defineMigrations } from '@tldraw/tlstore'
import { T } from '@tldraw/tlvalidate'

import { TLBaseShape, createShapeValidator } from './shape-validation'

/** @public */
export type SDImageShapeProps = {
	w: number
	h: number
	text: string
}

/** @public */
export type SDImageShape = TLBaseShape<'sdimage', SDImageShapeProps>

/** @public */
export const sdimageShapeTypeValidator: T.Validator<SDImageShape> = createShapeValidator(
	'sdimage',
	T.object({
		w: T.nonZeroNumber,
		h: T.nonZeroNumber,
		text: T.string,
	})
)

/** @public */
export const sdimageShapeTypeMigrations = defineMigrations({})
