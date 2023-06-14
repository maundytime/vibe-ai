import { sdimageShapeMigrations, sdimageShapeProps } from '@tldraw/tlschema'
import { defineShape } from '../../../config/defineShape'
import { SdimageShapeTool } from './SdimageShapeTool'
import { SdimageShapeUtil } from './SdimageShapeUtil'

/** @public */
export const SdimageShape = defineShape('sdimage', {
	util: SdimageShapeUtil,
	props: sdimageShapeProps,
	migrations: sdimageShapeMigrations,
	tool: SdimageShapeTool,
})
