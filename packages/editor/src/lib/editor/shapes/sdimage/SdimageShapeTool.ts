import { BaseBoxShapeTool } from '../../tools/BaseBoxShapeTool/BaseBoxShapeTool'

export class SdimageShapeTool extends BaseBoxShapeTool {
	static override id = 'sdimage'
	static initial = 'idle'

	shapeType = 'sdimage'
}
