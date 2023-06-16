import {
	Box2d,
	getPointOnCircle,
	linesIntersect,
	longAngleDist,
	Matrix2d,
	pointInPolygon,
	shortAngleDist,
	toDomPrecision,
	Vec2d,
	VecLike,
} from '@tldraw/primitives'
import { ComputedCache } from '@tldraw/store'
import {
	AssetRecordType,
	createShapeId,
	TLArrowheadType,
	TLArrowShape,
	TLColorType,
	TLFillType,
	TLGeoShape,
	TLHandle,
	TLImageAsset,
	TLImageCrop,
	TLImageShape,
	TLSdimageShape,
	TLShape,
	TLShapeId,
	TLShapePartial,
	TLTextShape,
	Vec2dModel,
} from '@tldraw/tlschema'
import { deepCopy, last, minBy } from '@tldraw/utils'
import * as React from 'react'
import { computed, EMPTY_ARRAY } from 'signia'
import { SVGContainer } from '../../../components/SVGContainer'
import { ARROW_LABEL_FONT_SIZES, FONT_FAMILIES, TEXT_PROPS } from '../../../constants'
import { getSvgAsDataUrl } from '../../../utils/export'
import {
	ShapeUtil,
	TLOnEditEndHandler,
	TLOnHandleChangeHandler,
	TLOnResizeHandler,
	TLOnTranslateStartHandler,
	TLShapeUtilFlag,
} from '../ShapeUtil'
import { createTextSvgElementFromSpans } from '../shared/createTextSvgElementFromSpans'
import { getPerfectDashProps } from '../shared/getPerfectDashProps'
import { getShapeFillSvg, ShapeFill } from '../shared/ShapeFill'
import { TLExportColors } from '../shared/TLExportColors'
import { ArrowInfo } from './arrow/arrow-types'
import { getArrowheadPathForType } from './arrow/arrowheads'
import {
	getCurvedArrowHandlePath,
	getCurvedArrowInfo,
	getSolidCurvedArrowPath,
} from './arrow/curved-arrow'
import { getArrowTerminalsInArrowSpace, getIsArrowStraight } from './arrow/shared'
import {
	getSolidStraightArrowPath,
	getStraightArrowHandlePath,
	getStraightArrowInfo,
} from './arrow/straight-arrow'
import { Message, OpenAIStream } from './Chat'
import { ArrowTextLabel } from './components/ArrowTextLabel'

let globalRenderIndex = 0

/** @public */
export class ArrowShapeUtil extends ShapeUtil<TLArrowShape> {
	static override type = 'arrow' as const

	override canEdit = () => true
	override canBind = () => false
	override isClosed = () => false
	override hideResizeHandles: TLShapeUtilFlag<TLArrowShape> = () => true
	override hideRotateHandle: TLShapeUtilFlag<TLArrowShape> = () => true
	override hideSelectionBoundsFg: TLShapeUtilFlag<TLArrowShape> = () => true
	override hideSelectionBoundsBg: TLShapeUtilFlag<TLArrowShape> = () => true

	override defaultProps(): TLArrowShape['props'] {
		return {
			dash: 'draw',
			size: 'm',
			fill: 'none',
			color: 'black',
			labelColor: 'black',
			bend: 0,
			start: { type: 'point', x: 0, y: 0 },
			end: { type: 'point', x: 0, y: 0 },
			arrowheadStart: 'none',
			arrowheadEnd: 'arrow',
			text: '',
			font: 'draw',
		}
	}

	onDraggingExit = (arrowShape: TLArrowShape) => {
		const { start, end } = arrowShape.props
		const startShapeId = (start as { boundShapeId?: TLShapeId }).boundShapeId
		const startShape = startShapeId ? this.editor.getShapeById(startShapeId) : undefined
		const endShapeId = (end as { boundShapeId?: TLShapeId }).boundShapeId
		const endShape = endShapeId ? this.editor.getShapeById(endShapeId) : undefined
		const startImageShape = startShape?.type === 'image' ? (startShape as TLImageShape) : undefined
		const startTextShape = startShape?.type === 'text' ? (startShape as TLTextShape) : undefined
		const startGeoShape = startShape?.type === 'geo' ? (startShape as TLGeoShape) : undefined
		const startTextGeoShape = startGeoShape && startGeoShape.props.text ? startGeoShape : undefined
		const endSdimageShape = endShape?.type === 'sdimage' ? (endShape as TLSdimageShape) : undefined
		const endGeoShape = endShape?.type === 'geo' ? (endShape as TLGeoShape) : undefined
		const endEmptyGeoShape = endGeoShape && !endGeoShape.props.text ? endGeoShape : undefined

		// shape -> sdimage = image
		if (startShape && endSdimageShape) {
			this.onAnyToImage(arrowShape, endSdimageShape)
		}
		// image -> ?/empty_geo = text/text_geo
		else if (startImageShape && (!endShape || endEmptyGeoShape)) {
			// dalle mode not able
			// this.onImageToText(arrowShape, startImageShape, endEmptyGeoShape)
		}
		// text/text_geo -> ?/empty_geo = text/text_geo
		else if ((startTextShape ?? startTextGeoShape) && (!endShape || endEmptyGeoShape)) {
			this.onTextToText(arrowShape, (startTextShape ?? startTextGeoShape)!, endEmptyGeoShape)
		}
	}

	getDataFromBase64 = async (base64: string, _crop?: TLImageCrop | null) => {
		const crop = _crop ?? {
			bottomRight: { x: 1, y: 1 },
			topLeft: { x: 0, y: 0 },
		}
		const sourceImage = await this.loadImage(base64)
		const canvas = document.createElement('canvas')
		const ctx = canvas.getContext('2d')!
		const cropWidth = sourceImage.width * (crop.bottomRight.x - crop.topLeft.x)
		const cropHeight = sourceImage.height * (crop.bottomRight.y - crop.topLeft.y)
		const cropX = sourceImage.width * crop.topLeft.x
		const cropY = sourceImage.height * crop.topLeft.y
		canvas.width = cropWidth
		canvas.height = cropHeight
		ctx.imageSmoothingEnabled = true
		ctx.imageSmoothingQuality = 'high'
		ctx.drawImage(sourceImage, cropX, cropY, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight)
		let hasTransparency = false
		const imageData = ctx.getImageData(0, 0, cropWidth, cropHeight).data
		for (let i = 3; i < imageData.length; i += 4) {
			if (imageData[i] != 255) {
				hasTransparency = true
				break
			}
		}
		return { canvas, hasTransparency }
	}

	getBlobFromBase64 = async (
		base64: string,
		crop?: TLImageCrop | null
	): Promise<{ blob: Blob; hasTransparency: boolean }> => {
		const { canvas, hasTransparency } = await this.getDataFromBase64(base64, crop)
		return new Promise((resolved) => {
			canvas.toBlob((blob) => {
				if (blob) {
					resolved({ blob, hasTransparency })
				}
			})
		})
	}

	getBase64FromBase64 = async (
		base64: string,
		crop?: TLImageCrop | null
	): Promise<{ base64: string; hasTransparency: boolean }> => {
		const { canvas, hasTransparency } = await this.getDataFromBase64(base64, crop)
		return { base64: canvas.toDataURL('image/png'), hasTransparency }
	}

	getCroppedData = async (imageShape: TLImageShape, type: 'base64' | 'blob') => {
		const assetId = imageShape.props.assetId
		if (!assetId) {
			return null
		}
		const imageAsset = this.editor.getAssetById(assetId) as TLImageAsset
		if (!imageAsset) {
			return null
		}
		const base64 = imageAsset.props.src
		if (!base64) {
			return null
		}
		const crop = imageShape.props.crop
		if (type === 'blob') {
			return await this.getBlobFromBase64(base64, crop)
		} else {
			return await this.getBase64FromBase64(base64, crop)
		}
	}

	onImageToText = async (
		arrowShape: TLArrowShape,
		startImageShape: TLImageShape,
		endEmptyGeoShape?: TLGeoShape
	) => {
		const data = await this.getCroppedData(startImageShape, 'base64')
		if (!data || !('base64' in data)) {
			return
		}
		const croppedAsset = data.base64
		this.editor.deselect(arrowShape.id)
		let endTextId: TLShapeId | undefined
		if (endEmptyGeoShape) {
			this.editor.updateShapes([
				{
					id: endEmptyGeoShape.id,
					type: 'geo',
					props: {
						text: '...',
						isChatAI: false,
						verticalAlign: 'middle',
					},
				},
			])
		} else {
			const { x: endX, y: endY } = arrowShape.props.end as { x: number; y: number }
			const x = endX + arrowShape.x
			const y = endY + arrowShape.y
			endTextId = createShapeId()
			this.editor.createShapes([
				{
					id: endTextId,
					type: 'text',
					x,
					y,
					props: {
						text: '...',
						align: 'start',
						w: 600,
						isChatAI: false,
					},
				},
			])
			this.editor.updateShapes([
				{
					id: arrowShape.id,
					type: 'arrow',
					props: {
						end: {
							type: 'binding',
							isExact: false,
							boundShapeId: endTextId,
							normalizedAnchor: { x: 0.5, y: 0.5 },
						},
					},
				},
			])
		}
		const endShapeId = endEmptyGeoShape ? endEmptyGeoShape.id : endTextId!
		const endShapeType = endEmptyGeoShape ? 'geo' : 'text'
		if (croppedAsset) {
			fetch(this.editor.sdURL + '/sdapi/v1/interrogate', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					image: croppedAsset,
					model: this.editor.sdInterrogateModel,
				}),
			})
				.then((response) => response.json())
				.then((data) => {
					const text = data.caption
					if (text) {
						if (endShapeType === 'geo') {
							this.editor.updateShapes([
								{
									id: endShapeId,
									type: 'geo',
									props: {
										text,
									},
								},
							])
						} else {
							this.editor.updateShapes([
								{
									id: endShapeId,
									type: 'text',
									props: {
										text,
										autoSize: false,
									},
								},
							])
						}
					} else {
						console.error('no caption found in data', data)
					}
				})
				.catch((error) => {
					console.error(error)
				})
		}
	}

	hasTransparency = async (base64: string) => {
		const image = await this.loadImage(base64)
		const canvas = document.createElement('canvas')
		canvas.width = image.width
		canvas.height = image.height
		const ctx = canvas.getContext('2d')!
		ctx.drawImage(image, 0, 0)
		const imageData = ctx.getImageData(0, 0, image.width, image.height).data
		for (let i = 3; i < imageData.length; i += 4) {
			if (imageData[i] != 255) {
				return true
			}
		}
		return false
	}

	loadImage = (base64: string): Promise<HTMLImageElement> => {
		return new Promise((resolved) => {
			const i = new Image()
			i.onload = function () {
				resolved(i)
			}
			i.src = base64
		})
	}

	onAnyToImage = async (arrowShape: TLArrowShape, sdimageShape: TLSdimageShape) => {
		const w = sdimageShape.props.w
		const h = sdimageShape.props.h
		this.editor.sdSetPreferSize({ w, h })
		const requestWidth = w <= 256 ? 256 : w <= 512 ? 512 : 1024
		const requestHeight = requestWidth
		const imageId = createShapeId()
		const bindingShapes = this.findBindingTree(sdimageShape, false)
		let allTexts = ''
		const allAssets: { blob: Blob; hasTransparency: boolean; index: number }[] = []
		for (let i = 0; i < bindingShapes.length; i++) {
			const e = bindingShapes[bindingShapes.length - i - 1]
			if ('text' in e.props && e.props.text) {
				if (!allTexts.length) {
					allTexts += ' '
				}
				allTexts += e.props.text
			} else if (allAssets.length) {
				continue
			} else if (e.type === 'image' && 'assetId' in e.props && e.props.assetId) {
				const data = await this.getCroppedData(e as TLImageShape, 'blob')
				if (data && 'blob' in data) {
					allAssets.push({ ...data, index: i })
				}
			} else if (e.type === 'frame') {
				const svg = await this.editor.getSvg([e.id], {
					scale: 1,
					background: false,
				})
				if (svg) {
					const base64 = await getSvgAsDataUrl(svg)
					const asset = await this.getBlobFromBase64(base64)
					URL.revokeObjectURL(base64)
					if (asset) {
						const { blob, hasTransparency } = asset
						allAssets.push({ blob, hasTransparency: hasTransparency, index: i })
					}
				}
			}
		}

		const isVariations = allAssets[0] && allAssets[0].index === 0 && !allAssets[0].hasTransparency
		const isEdits = allAssets[0] && allAssets[0].hasTransparency
		const url =
			this.editor.openaiURL +
			'/v1/images' +
			(isVariations ? '/variations' : isEdits ? '/edits' : '/generations')

		let body
		let headers
		if (isVariations) {
			const formData = new FormData()
			formData.append('image', allAssets[0].blob)
			formData.append('n', '1')
			formData.append('size', `${requestWidth}x${requestHeight}`)
			formData.append('response_format', 'b64_json')
			body = formData
		} else if (isEdits) {
			if (!allTexts) {
				this.editor.emit('ai-need-text')
				this.editor.deleteShapes([arrowShape.id])
				return
			}
			const formData = new FormData()
			formData.append('image', allAssets[0].blob)
			formData.append('prompt', allTexts)
			formData.append('n', '1')
			formData.append('size', `${requestWidth}x${requestHeight}`)
			formData.append('response_format', 'b64_json')
			body = formData
		} else {
			if (!allTexts) {
				this.editor.emit('ai-need-text')
				this.editor.deleteShapes([arrowShape.id])
				return
			}
			const bodyObject: any = {
				prompt: allTexts,
				n: 1,
				response_format: 'b64_json',
				size: `${requestWidth}x${requestHeight}`,
			}
			body = JSON.stringify(bodyObject)
			headers = { 'content-type': 'application/json' }
		}
		fetch(url, {
			method: 'POST',
			headers,
			body,
		})
			.then((response) => response.json())
			.then((data) => {
				const assetId = AssetRecordType.createId()
				const assetSrc = 'data:image/png;base64,' + data['data'][0]['b64_json']
				const responseImage = new Image()
				responseImage.src = assetSrc
				const sdResponseWidth = responseImage.width
				const sdResponseHeight = responseImage.height
				this.editor.createAssets([
					{
						id: assetId,
						type: 'image',
						typeName: 'asset',
						props: {
							name: 'file',
							src: assetSrc,
							w: sdResponseWidth,
							h: sdResponseHeight,
							mimeType: null,
							isAnimated: false,
						},
					},
				])
				this.editor.updateShapes([
					{
						id: imageId,
						type: 'image',
						props: {
							assetId: assetId,
						},
					},
				])
			})
			.catch((error) => {
				console.error(error)
			})
		this.editor.createShapes([
			{
				id: imageId,
				type: 'image',
				x: sdimageShape.x,
				y: sdimageShape.y,
				props: {
					w: sdimageShape.props.w,
					h: sdimageShape.props.h,
				},
			},
		])
		this.editor.deselect(arrowShape.id)
		this.editor.updateShapes([
			{
				id: arrowShape.id,
				type: 'arrow',
				props: {
					end: {
						type: 'binding',
						isExact: false,
						boundShapeId: imageId,
						normalizedAnchor: { x: 0.5, y: 0.5 },
					},
				},
			},
		])
		this.editor.deleteShapes([sdimageShape.id])
	}

	onTextToText = (
		arrowShape: TLArrowShape,
		startTextKindShape: TLTextShape | TLGeoShape,
		endEmptyGeoShape?: TLGeoShape
	) => {
		this.editor.deselect(arrowShape.id)
		let endChatId: TLShapeId | undefined
		if (endEmptyGeoShape) {
			this.editor.updateShapes([
				{
					id: endEmptyGeoShape.id,
					type: 'geo',
					props: {
						text: '...',
						isChatAI: true,
						verticalAlign: 'middle',
					},
				},
			])
		} else {
			endChatId = createShapeId()
			const { x: endX, y: endY } = arrowShape.props.end as { x: number; y: number }
			const x = endX + arrowShape.x
			const y = endY + arrowShape.y
			if (startTextKindShape.type === 'geo') {
				const { color, font, size, w, fill, dash } = (startTextKindShape as TLGeoShape).props
				this.editor.createShapes([
					{
						id: endChatId,
						type: 'geo',
						x,
						y,
						props: {
							align: 'start',
							color,
							dash,
							fill,
							font,
							geo: 'rectangle',
							isChatAI: true,
							size,
							text: '...',
							verticalAlign: 'start',
							w,
						},
					},
				])
			} else {
				const { color, font, size, w } = (startTextKindShape as TLTextShape).props
				this.editor.createShapes([
					{
						id: endChatId,
						type: 'text',
						x,
						y,
						props: {
							align: 'start',
							color,
							font,
							size,
							text: '...',
							// text width may be small when autoSize true, like one word 'hi'
							w: Math.max(600, w),
							isChatAI: true,
						},
					},
				])
			}
			this.editor.updateShapes([
				{
					id: arrowShape.id,
					type: 'arrow',
					props: {
						end: {
							type: 'binding',
							isExact: false,
							boundShapeId: endChatId,
							normalizedAnchor: { x: 0.5, y: 0.5 },
						},
					},
				},
			])
		}
		const endShapeId = endChatId ?? endEmptyGeoShape!.id
		const textKindShapes = this.findBindingTree(startTextKindShape).filter(
			(e) => 'text' in e.props && 'isChatAI' in e.props
		)
		const messages: Message[] = textKindShapes.map((e) => ({
			role: 'isChatAI' in e.props && e.props.isChatAI ? 'assistant' : 'user',
			content: 'text' in e.props ? e.props.text : '',
		}))
		// messages.unshift({
		// 	role: 'system',
		// 	content: 'I want you to act as an IT Expert. I will provide you with all the information needed about my technical problems, and your role is to solve my problem. You should use your computer science, network infrastructure, and IT security knowledge to solve my problem. Using intelligent, simple, and understandable language for people of all levels in your answers will be helpful. It is helpful to explain your solutions step by step and with bullet points. Try to avoid too many technical details, but use them when necessary. I want you to reply with the solution, not write any explanations.',
		// })
		let isFirst = true
		OpenAIStream(messages, (content) => {
			const endShape = this.editor.getShapeById(endShapeId)
			if (!endShape) {
				return
			}
			const endTextKindShape = endShape as TLTextShape | TLGeoShape
			const text = (isFirst ? '' : endTextKindShape.props.text) + content
			isFirst = false
			if (endTextKindShape.type === 'geo') {
				this.editor.updateShapes([
					{
						id: endShapeId,
						type: 'geo',
						props: {
							text,
						},
					},
				])
			} else {
				this.editor.updateShapes([
					{
						id: endShapeId,
						type: 'text',
						props: {
							text,
							autoSize: false,
						},
					},
				])
			}
		})
	}

	findBindingTree(shape: TLShape, containFirst = true): TLShape[] {
		const ids = [shape.id]
		const idSet = new Set(ids)
		const shapes: TLShape[] = containFirst ? [shape] : []
		while (ids.length) {
			const id = ids.shift()!
			const arrows = this.editor.getArrowsBoundTo(id)
			arrows.forEach((arrow) => {
				// .filter((e) => e.handleId === 'end')
				const arrowShape = this.editor.getShapeById(arrow.arrowId) as TLArrowShape
				// const arrowheadStart =  // pipe what is this?
				const { start, end } = arrowShape.props
				const endToId =
					arrowShape.props.arrowheadStart !== 'none' &&
					start.type === 'binding' &&
					start.boundShapeId === id &&
					end.type === 'binding'
						? end.boundShapeId
						: undefined
				const startToId =
					arrowShape.props.arrowheadEnd !== 'none' &&
					end.type === 'binding' &&
					end.boundShapeId === id &&
					start.type === 'binding'
						? start.boundShapeId
						: undefined
				const anotherId = startToId ?? endToId
				if (anotherId) {
					const anotherShape = this.editor.getShapeById(anotherId)
					if (anotherShape && !idSet.has(anotherId)) {
						ids.push(anotherId)
						idSet.add(anotherId)
						shapes.unshift(anotherShape)
					}
				}
			})
		}
		return shapes
	}

	getCenter(shape: TLArrowShape): Vec2d {
		return this.bounds(shape).center
	}

	getBounds(shape: TLArrowShape) {
		return Box2d.FromPoints(this.getOutlineWithoutLabel(shape))
	}

	getOutlineWithoutLabel(shape: TLArrowShape) {
		const info = this.getArrowInfo(shape)

		if (!info) {
			return []
		}

		if (info.isStraight) {
			if (info.isValid) {
				return [info.start.point, info.end.point]
			} else {
				return [new Vec2d(0, 0), new Vec2d(1, 1)]
			}
		}

		if (!info.isValid) {
			return [new Vec2d(0, 0), new Vec2d(1, 1)]
		}

		const pointsToPush = Math.max(5, Math.ceil(Math.abs(info.bodyArc.length) / 16))

		if (pointsToPush <= 0 && !isFinite(pointsToPush)) {
			return [new Vec2d(0, 0), new Vec2d(1, 1)]
		}

		const results: Vec2d[] = Array(pointsToPush)

		const startAngle = Vec2d.Angle(info.bodyArc.center, info.start.point)
		const endAngle = Vec2d.Angle(info.bodyArc.center, info.end.point)

		const a = info.bodyArc.sweepFlag ? endAngle : startAngle
		const b = info.bodyArc.sweepFlag ? startAngle : endAngle
		const l = info.bodyArc.largeArcFlag ? -longAngleDist(a, b) : shortAngleDist(a, b)

		const r = Math.max(1, info.bodyArc.radius)

		for (let i = 0; i < pointsToPush; i++) {
			const t = i / (pointsToPush - 1)
			const angle = a + l * t
			const point = getPointOnCircle(info.bodyArc.center.x, info.bodyArc.center.y, r, angle)
			results[i] = point
		}

		return results
	}

	getOutline(shape: TLArrowShape): Vec2dModel[] {
		const outlineWithoutLabel = this.getOutlineWithoutLabel(shape)

		const labelBounds = this.getLabelBounds(shape)
		if (!labelBounds) {
			return outlineWithoutLabel
		}

		const sides = labelBounds.sides
		const sideIndexes = [0, 1, 2, 3]

		// start with the first point...
		let prevPoint = outlineWithoutLabel[0]
		let didAddLabel = false
		const result = [prevPoint]
		for (let i = 1; i < outlineWithoutLabel.length; i++) {
			// ...and use the next point to form a line segment for the outline.
			const nextPoint = outlineWithoutLabel[i]

			if (!didAddLabel) {
				// find the index of the side of the label bounds that intersects the line segment
				const nearestIntersectingSideIndex = minBy(
					sideIndexes.filter((sideIndex) =>
						linesIntersect(sides[sideIndex][0], sides[sideIndex][1], prevPoint, nextPoint)
					),
					(sideIndex) =>
						Vec2d.DistanceToLineSegment(sides[sideIndex][0], sides[sideIndex][1], prevPoint)
				)

				// if we've found one, start at that index and trace around all four corners of the label bounds
				if (nearestIntersectingSideIndex !== undefined) {
					const intersectingPoint = Vec2d.NearestPointOnLineSegment(
						sides[nearestIntersectingSideIndex][0],
						sides[nearestIntersectingSideIndex][1],
						prevPoint
					)

					result.push(intersectingPoint)
					for (let j = 0; j < 4; j++) {
						const sideIndex = (nearestIntersectingSideIndex + j) % 4
						result.push(sides[sideIndex][1])
					}
					result.push(intersectingPoint)

					// we've added the label, so we can just continue with the rest of the outline as normal
					didAddLabel = true
				}
			}

			result.push(nextPoint)
			prevPoint = nextPoint
		}

		return result
	}

	snapPoints(_shape: TLArrowShape): Vec2d[] {
		return EMPTY_ARRAY
	}

	@computed
	private get infoCache() {
		return this.editor.store.createComputedCache<ArrowInfo, TLArrowShape>(
			'arrow infoCache',
			(shape) => {
				return getIsArrowStraight(shape)
					? getStraightArrowInfo(this.editor, shape)
					: getCurvedArrowInfo(this.editor, shape)
			}
		)
	}

	getArrowInfo(shape: TLArrowShape) {
		return this.infoCache.get(shape.id)
	}

	getHandles(shape: TLArrowShape): TLHandle[] {
		const info = this.infoCache.get(shape.id)!
		return [
			{
				id: 'start',
				type: 'vertex',
				index: 'a0',
				x: info.start.handle.x,
				y: info.start.handle.y,
				canBind: true,
			},
			{
				id: 'middle',
				type: 'vertex',
				index: 'a2',
				x: info.middle.x,
				y: info.middle.y,
				canBind: false,
			},
			{
				id: 'end',
				type: 'vertex',
				index: 'a3',
				x: info.end.handle.x,
				y: info.end.handle.y,
				canBind: true,
			},
		]
	}

	onHandleChange: TLOnHandleChangeHandler<TLArrowShape> = (shape, { handle, isPrecise }) => {
		const next = deepCopy(shape)

		switch (handle.id) {
			case 'start':
			case 'end': {
				const pageTransform = this.editor.getPageTransformById(next.id)!
				const pointInPageSpace = Matrix2d.applyToPoint(pageTransform, handle)

				if (this.editor.inputs.ctrlKey) {
					next.props[handle.id] = {
						type: 'point',
						x: handle.x,
						y: handle.y,
					}
				} else {
					const target = last(
						this.editor.sortedShapesArray.filter((hitShape) => {
							if (hitShape.id === shape.id) {
								// We're testing against the arrow
								return
							}

							const util = this.editor.getShapeUtil(hitShape)
							if (!util.canBind(hitShape)) {
								// The shape can't be bound to
								return
							}

							// Check the page mask
							const pageMask = this.editor.getPageMaskById(hitShape.id)
							if (pageMask) {
								if (!pointInPolygon(pointInPageSpace, pageMask)) return
							}

							const pointInTargetSpace = this.editor.getPointInShapeSpace(
								hitShape,
								pointInPageSpace
							)

							if (util.isClosed(hitShape)) {
								// Test the polygon
								return pointInPolygon(pointInTargetSpace, util.outline(hitShape))
							}

							// Test the point using the shape's idea of what a hit is
							return util.hitTestPoint(hitShape, pointInTargetSpace)
						})
					)

					if (target) {
						const targetBounds = this.editor.getBounds(target)
						const pointInTargetSpace = this.editor.getPointInShapeSpace(target, pointInPageSpace)

						const prevHandle = next.props[handle.id]

						const startBindingId =
							shape.props.start.type === 'binding' && shape.props.start.boundShapeId
						const endBindingId = shape.props.end.type === 'binding' && shape.props.end.boundShapeId

						let precise =
							// If externally precise, then always precise
							isPrecise ||
							// If the other handle is bound to the same shape, then precise
							((startBindingId || endBindingId) && startBindingId === endBindingId) ||
							// If the other shape is not closed, then precise
							!this.editor.getShapeUtil(target).isClosed(next)

						if (
							// If we're switching to a new bound shape, then precise only if moving slowly
							prevHandle.type === 'point' ||
							(prevHandle.type === 'binding' && target.id !== prevHandle.boundShapeId)
						) {
							precise = this.editor.inputs.pointerVelocity.len() < 0.5
						}

						if (precise) {
							// Funky math but we want the snap distance to be 4 at the minimum and either
							// 16 or 15% of the smaller dimension of the target shape, whichever is smaller
							precise =
								Vec2d.Dist(pointInTargetSpace, targetBounds.center) >
								Math.max(
									4,
									Math.min(Math.min(targetBounds.width, targetBounds.height) * 0.15, 16)
								) /
									this.editor.zoomLevel
						}

						next.props[handle.id] = {
							type: 'binding',
							boundShapeId: target.id,
							normalizedAnchor: precise
								? {
										x: (pointInTargetSpace.x - targetBounds.minX) / targetBounds.width,
										y: (pointInTargetSpace.y - targetBounds.minY) / targetBounds.height,
								  }
								: { x: 0.5, y: 0.5 },
							isExact: this.editor.inputs.altKey,
						}
					} else {
						next.props[handle.id] = {
							type: 'point',
							x: handle.x,
							y: handle.y,
						}
					}
				}
				break
			}

			case 'middle': {
				const { start, end } = getArrowTerminalsInArrowSpace(this.editor, next)

				const delta = Vec2d.Sub(end, start)
				const v = Vec2d.Per(delta)

				const med = Vec2d.Med(end, start)
				const A = Vec2d.Sub(med, v)
				const B = Vec2d.Add(med, v)

				const point = Vec2d.NearestPointOnLineSegment(A, B, handle, false)
				let bend = Vec2d.Dist(point, med)
				if (Vec2d.Clockwise(point, end, med)) bend *= -1
				next.props.bend = bend
				break
			}
		}

		return next
	}

	onTranslateStart: TLOnTranslateStartHandler<TLArrowShape> = (shape) => {
		let startBinding: TLShapeId | null =
			shape.props.start.type === 'binding' ? shape.props.start.boundShapeId : null
		let endBinding: TLShapeId | null =
			shape.props.end.type === 'binding' ? shape.props.end.boundShapeId : null

		// If at least one bound shape is in the selection, do nothing;
		// If no bound shapes are in the selection, unbind any bound shapes

		if (
			(startBinding && this.editor.isWithinSelection(startBinding)) ||
			(endBinding && this.editor.isWithinSelection(endBinding))
		) {
			return
		}

		startBinding = null
		endBinding = null

		const { start, end } = getArrowTerminalsInArrowSpace(this.editor, shape)

		return {
			id: shape.id,
			type: shape.type,
			props: {
				...shape.props,
				start: {
					type: 'point',
					x: start.x,
					y: start.y,
				},
				end: {
					type: 'point',
					x: end.x,
					y: end.y,
				},
			},
		}
	}

	onResize: TLOnResizeHandler<TLArrowShape> = (shape, info) => {
		const { scaleX, scaleY } = info

		const terminals = getArrowTerminalsInArrowSpace(this.editor, shape)

		const { start, end } = deepCopy<TLArrowShape['props']>(shape.props)
		let { bend } = shape.props

		// Rescale start handle if it's not bound to a shape
		if (start.type === 'point') {
			start.x = terminals.start.x * scaleX
			start.y = terminals.start.y * scaleY
		}

		// Rescale end handle if it's not bound to a shape
		if (end.type === 'point') {
			end.x = terminals.end.x * scaleX
			end.y = terminals.end.y * scaleY
		}

		// todo: we should only change the normalized anchor positions
		// of the shape's handles if the bound shape is also being resized

		const mx = Math.abs(scaleX)
		const my = Math.abs(scaleY)

		if (scaleX < 0 && scaleY >= 0) {
			if (bend !== 0) {
				bend *= -1
				bend *= Math.max(mx, my)
			}

			if (start.type === 'binding') {
				start.normalizedAnchor.x = 1 - start.normalizedAnchor.x
			}

			if (end.type === 'binding') {
				end.normalizedAnchor.x = 1 - end.normalizedAnchor.x
			}
		} else if (scaleX >= 0 && scaleY < 0) {
			if (bend !== 0) {
				bend *= -1
				bend *= Math.max(mx, my)
			}

			if (start.type === 'binding') {
				start.normalizedAnchor.y = 1 - start.normalizedAnchor.y
			}

			if (end.type === 'binding') {
				end.normalizedAnchor.y = 1 - end.normalizedAnchor.y
			}
		} else if (scaleX >= 0 && scaleY >= 0) {
			if (bend !== 0) {
				bend *= Math.max(mx, my)
			}
		} else if (scaleX < 0 && scaleY < 0) {
			if (bend !== 0) {
				bend *= Math.max(mx, my)
			}

			if (start.type === 'binding') {
				start.normalizedAnchor.x = 1 - start.normalizedAnchor.x
				start.normalizedAnchor.y = 1 - start.normalizedAnchor.y
			}

			if (end.type === 'binding') {
				end.normalizedAnchor.x = 1 - end.normalizedAnchor.x
				end.normalizedAnchor.y = 1 - end.normalizedAnchor.y
			}
		}

		const next = {
			props: {
				start,
				end,
				bend,
			},
		}

		return next
	}

	onDoubleClickHandle = (
		shape: TLArrowShape,
		handle: TLHandle
	): TLShapePartial<TLArrowShape> | void => {
		switch (handle.id) {
			case 'start': {
				return {
					id: shape.id,
					type: shape.type,
					props: {
						...shape.props,
						arrowheadStart: shape.props.arrowheadStart === 'none' ? 'arrow' : 'none',
					},
				}
			}
			case 'end': {
				return {
					id: shape.id,
					type: shape.type,
					props: {
						...shape.props,
						arrowheadEnd: shape.props.arrowheadEnd === 'none' ? 'arrow' : 'none',
					},
				}
			}
		}
	}

	hitTestPoint(shape: TLArrowShape, point: VecLike): boolean {
		const outline = this.outline(shape)
		const zoomLevel = this.editor.zoomLevel
		const offsetDist = this.editor.getStrokeWidth(shape.props.size) / zoomLevel

		for (let i = 0; i < outline.length - 1; i++) {
			const C = outline[i]
			const D = outline[i + 1]

			if (Vec2d.DistanceToLineSegment(C, D, point) < offsetDist) return true
		}

		return false
	}

	hitTestLineSegment(shape: TLArrowShape, A: VecLike, B: VecLike): boolean {
		const outline = this.outline(shape)

		for (let i = 0; i < outline.length - 1; i++) {
			const C = outline[i]
			const D = outline[i + 1]
			if (linesIntersect(A, B, C, D)) return true
		}

		return false
	}

	render(shape: TLArrowShape) {
		// Not a class component, but eslint can't tell that :(
		const onlySelectedShape = this.editor.onlySelectedShape
		const shouldDisplayHandles =
			this.editor.isInAny(
				'select.idle',
				'select.pointing_handle',
				'select.dragging_handle',
				'arrow.dragging'
			) && !this.editor.isReadOnly

		const info = this.getArrowInfo(shape)
		const bounds = this.bounds(shape)
		const labelSize = this.getLabelBounds(shape)

		// eslint-disable-next-line react-hooks/rules-of-hooks
		const changeIndex = React.useMemo<number>(() => {
			return this.editor.isSafari ? (globalRenderIndex += 1) : 0
			// eslint-disable-next-line react-hooks/exhaustive-deps
		}, [shape])

		if (!info?.isValid) return null

		const strokeWidth = this.editor.getStrokeWidth(shape.props.size)

		const as = info.start.arrowhead && getArrowheadPathForType(info, 'start', strokeWidth)
		const ae = info.end.arrowhead && getArrowheadPathForType(info, 'end', strokeWidth)

		const path = info.isStraight ? getSolidStraightArrowPath(info) : getSolidCurvedArrowPath(info)

		let handlePath: null | JSX.Element = null

		if (onlySelectedShape === shape && shouldDisplayHandles) {
			const sw = 2
			const { strokeDasharray, strokeDashoffset } = getPerfectDashProps(
				info.isStraight
					? Vec2d.Dist(info.start.handle, info.end.handle)
					: Math.abs(info.handleArc.length),
				sw,
				{
					end: 'skip',
					start: 'skip',
					lengthRatio: 2.5,
				}
			)

			handlePath =
				shape.props.start.type === 'binding' || shape.props.end.type === 'binding' ? (
					<path
						className="tl-arrow-hint"
						d={info.isStraight ? getStraightArrowHandlePath(info) : getCurvedArrowHandlePath(info)}
						strokeDasharray={strokeDasharray}
						strokeDashoffset={strokeDashoffset}
						strokeWidth={sw}
						markerStart={
							shape.props.start.type === 'binding'
								? shape.props.start.isExact
									? ''
									: isPrecise(shape.props.start.normalizedAnchor)
									? 'url(#arrowhead-cross)'
									: 'url(#arrowhead-dot)'
								: ''
						}
						markerEnd={
							shape.props.end.type === 'binding'
								? shape.props.end.isExact
									? ''
									: isPrecise(shape.props.end.normalizedAnchor)
									? 'url(#arrowhead-cross)'
									: 'url(#arrowhead-dot)'
								: ''
						}
						opacity={0.16}
					/>
				) : null
		}

		const { strokeDasharray, strokeDashoffset } = getPerfectDashProps(
			info.isStraight ? info.length : Math.abs(info.bodyArc.length),
			strokeWidth,
			{
				style: shape.props.dash,
			}
		)

		const maskStartArrowhead = !(
			info.start.arrowhead === 'none' || info.start.arrowhead === 'arrow'
		)
		const maskEndArrowhead = !(info.end.arrowhead === 'none' || info.end.arrowhead === 'arrow')
		const includeMask = maskStartArrowhead || maskEndArrowhead || labelSize

		// NOTE: I know right setting `changeIndex` hacky-as right! But we need this because otherwise safari loses
		// the mask, see <https://linear.app/tldraw/issue/TLD-1500/changing-arrow-color-makes-line-pass-through-text>
		const maskId = (shape.id + '_clip_' + changeIndex).replace(':', '_')

		return (
			<>
				<SVGContainer id={shape.id} style={{ minWidth: 50, minHeight: 50 }}>
					{includeMask && (
						<defs>
							<mask id={maskId}>
								<rect
									x={toDomPrecision(-100 + bounds.minX)}
									y={toDomPrecision(-100 + bounds.minY)}
									width={toDomPrecision(bounds.width + 200)}
									height={toDomPrecision(bounds.height + 200)}
									fill="white"
								/>
								{labelSize && (
									<rect
										x={toDomPrecision(labelSize.x)}
										y={toDomPrecision(labelSize.y)}
										width={toDomPrecision(labelSize.w)}
										height={toDomPrecision(labelSize.h)}
										fill="black"
										rx={4}
										ry={4}
									/>
								)}
								{as && maskStartArrowhead && (
									<path
										d={as}
										fill={info.start.arrowhead === 'arrow' ? 'none' : 'black'}
										stroke="none"
									/>
								)}
								{ae && maskEndArrowhead && (
									<path
										d={ae}
										fill={info.end.arrowhead === 'arrow' ? 'none' : 'black'}
										stroke="none"
									/>
								)}
							</mask>
						</defs>
					)}
					<g
						fill="none"
						stroke="currentColor"
						strokeWidth={strokeWidth}
						strokeLinejoin="round"
						strokeLinecap="round"
						pointerEvents="none"
					>
						{handlePath}
						{/* firefox will clip if you provide a maskURL even if there is no mask matching that URL in the DOM */}
						<g {...(includeMask ? { mask: `url(#${maskId})` } : undefined)}>
							{/* This rect needs to be here if we're creating a mask due to an svg quirk on Chrome */}
							{includeMask && (
								<rect
									x={toDomPrecision(bounds.minX - 100)}
									y={toDomPrecision(bounds.minY - 100)}
									width={toDomPrecision(bounds.width + 200)}
									height={toDomPrecision(bounds.height + 200)}
									opacity={0}
								/>
							)}
							<path
								d={path}
								strokeDasharray={strokeDasharray}
								strokeDashoffset={strokeDashoffset}
							/>
						</g>
						{as && maskStartArrowhead && shape.props.fill !== 'none' && (
							<ShapeFill d={as} color={shape.props.color} fill={shape.props.fill} />
						)}
						{ae && maskEndArrowhead && shape.props.fill !== 'none' && (
							<ShapeFill d={ae} color={shape.props.color} fill={shape.props.fill} />
						)}
						{as && <path d={as} />}
						{ae && <path d={ae} />}
					</g>
					<path d={path} className="tl-hitarea-stroke" />
				</SVGContainer>
				<ArrowTextLabel
					id={shape.id}
					text={shape.props.text}
					font={shape.props.font}
					size={shape.props.size}
					position={info.middle}
					width={labelSize?.w ?? 0}
					labelColor={this.editor.getCssColor(shape.props.labelColor)}
				/>
			</>
		)
	}

	indicator(shape: TLArrowShape) {
		const { start, end } = getArrowTerminalsInArrowSpace(this.editor, shape)

		const info = this.getArrowInfo(shape)
		const bounds = this.bounds(shape)
		const labelSize = this.getLabelBounds(shape)

		if (!info) return null
		if (Vec2d.Equals(start, end)) return null

		const strokeWidth = this.editor.getStrokeWidth(shape.props.size)

		const as = info.start.arrowhead && getArrowheadPathForType(info, 'start', strokeWidth)
		const ae = info.end.arrowhead && getArrowheadPathForType(info, 'end', strokeWidth)

		const path = info.isStraight ? getSolidStraightArrowPath(info) : getSolidCurvedArrowPath(info)

		const includeMask =
			(as && info.start.arrowhead !== 'arrow') ||
			(ae && info.end.arrowhead !== 'arrow') ||
			labelSize !== null

		const maskId = (shape.id + '_clip').replace(':', '_')

		return (
			<g>
				{includeMask && (
					<defs>
						<mask id={maskId}>
							<rect
								x={bounds.minX - 100}
								y={bounds.minY - 100}
								width={bounds.w + 200}
								height={bounds.h + 200}
								fill="white"
							/>
							{labelSize && (
								<rect
									x={labelSize.x}
									y={labelSize.y}
									width={labelSize.w}
									height={labelSize.h}
									fill="black"
									rx={4}
									ry={4}
								/>
							)}
							{as && (
								<path
									d={as}
									fill={info.start.arrowhead === 'arrow' ? 'none' : 'black'}
									stroke="none"
								/>
							)}
							{ae && (
								<path
									d={ae}
									fill={info.end.arrowhead === 'arrow' ? 'none' : 'black'}
									stroke="none"
								/>
							)}
						</mask>
					</defs>
				)}
				{/* firefox will clip if you provide a maskURL even if there is no mask matching that URL in the DOM */}
				<g {...(includeMask ? { mask: `url(#${maskId})` } : undefined)}>
					{/* This rect needs to be here if we're creating a mask due to an svg quirk on Chrome */}
					{includeMask && (
						<rect
							x={bounds.minX - 100}
							y={bounds.minY - 100}
							width={bounds.width + 200}
							height={bounds.height + 200}
							opacity={0}
						/>
					)}

					<path d={path} />
				</g>
				{as && <path d={as} />}
				{ae && <path d={ae} />}
				{labelSize && (
					<rect
						x={labelSize.x}
						y={labelSize.y}
						width={labelSize.w}
						height={labelSize.h}
						rx={4}
						ry={4}
					/>
				)}
			</g>
		)
	}

	@computed get labelBoundsCache(): ComputedCache<Box2d | null, TLArrowShape> {
		return this.editor.store.createComputedCache('labelBoundsCache', (shape) => {
			const info = this.getArrowInfo(shape)
			const bounds = this.bounds(shape)
			const { text, font, size } = shape.props

			if (!info) return null
			if (!text.trim()) return null

			const { w, h } = this.editor.textMeasure.measureText(text, {
				...TEXT_PROPS,
				fontFamily: FONT_FAMILIES[font],
				fontSize: ARROW_LABEL_FONT_SIZES[size],
				width: 'fit-content',
			})

			let width = w
			let height = h

			if (bounds.width > bounds.height) {
				width = Math.max(Math.min(w, 64), Math.min(bounds.width - 64, w))

				const { w: squishedWidth, h: squishedHeight } = this.editor.textMeasure.measureText(text, {
					...TEXT_PROPS,
					fontFamily: FONT_FAMILIES[font],
					fontSize: ARROW_LABEL_FONT_SIZES[size],
					width: width + 'px',
				})

				width = squishedWidth
				height = squishedHeight
			}

			if (width > 16 * ARROW_LABEL_FONT_SIZES[size]) {
				width = 16 * ARROW_LABEL_FONT_SIZES[size]

				const { w: squishedWidth, h: squishedHeight } = this.editor.textMeasure.measureText(text, {
					...TEXT_PROPS,
					fontFamily: FONT_FAMILIES[font],
					fontSize: ARROW_LABEL_FONT_SIZES[size],
					width: width + 'px',
				})

				width = squishedWidth
				height = squishedHeight
			}

			return new Box2d(
				info.middle.x - (width + 8) / 2,
				info.middle.y - (height + 8) / 2,
				width + 8,
				height + 8
			)
		})
	}

	getLabelBounds(shape: TLArrowShape): Box2d | null {
		return this.labelBoundsCache.get(shape.id) || null
	}

	getEditingBounds = (shape: TLArrowShape): Box2d => {
		return this.getLabelBounds(shape) ?? new Box2d()
	}

	onEditEnd: TLOnEditEndHandler<TLArrowShape> = (shape) => {
		const {
			id,
			type,
			props: { text },
		} = shape

		if (text.trimEnd() !== shape.props.text) {
			this.editor.updateShapes<TLArrowShape>([
				{
					id,
					type,
					props: {
						text: text.trimEnd(),
					},
				},
			])
		}
	}

	toSvg(shape: TLArrowShape, font: string, colors: TLExportColors) {
		const color = colors.fill[shape.props.color]

		const info = this.getArrowInfo(shape)

		const strokeWidth = this.editor.getStrokeWidth(shape.props.size)

		// Group for arrow
		const g = document.createElementNS('http://www.w3.org/2000/svg', 'g')
		if (!info) return g

		// Arrowhead start path
		const as = info.start.arrowhead && getArrowheadPathForType(info, 'start', strokeWidth)
		// Arrowhead end path
		const ae = info.end.arrowhead && getArrowheadPathForType(info, 'end', strokeWidth)

		const bounds = this.bounds(shape)
		const labelSize = this.getLabelBounds(shape)

		const maskId = (shape.id + '_clip').replace(':', '_')

		// If we have any arrowheads, then mask the arrowheads
		if (as || ae || labelSize) {
			// Create mask for arrowheads

			// Create defs
			const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs')

			// Create mask
			const mask = document.createElementNS('http://www.w3.org/2000/svg', 'mask')
			mask.id = maskId

			// Create large white shape for mask
			const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
			rect.setAttribute('x', bounds.minX - 100 + '')
			rect.setAttribute('y', bounds.minY - 100 + '')
			rect.setAttribute('width', bounds.width + 200 + '')
			rect.setAttribute('height', bounds.height + 200 + '')
			rect.setAttribute('fill', 'white')
			mask.appendChild(rect)

			// add arrowhead start mask
			if (as) mask.appendChild(getArrowheadSvgMask(as, info.start.arrowhead))

			// add arrowhead end mask
			if (ae) mask.appendChild(getArrowheadSvgMask(ae, info.end.arrowhead))

			// Mask out text label if text is present
			if (labelSize) {
				const labelMask = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
				labelMask.setAttribute('x', labelSize.x + '')
				labelMask.setAttribute('y', labelSize.y + '')
				labelMask.setAttribute('width', labelSize.w + '')
				labelMask.setAttribute('height', labelSize.h + '')
				labelMask.setAttribute('fill', 'black')

				mask.appendChild(labelMask)
			}

			defs.appendChild(mask)
			g.appendChild(defs)
		}

		const g2 = document.createElementNS('http://www.w3.org/2000/svg', 'g')
		g2.setAttribute('mask', `url(#${maskId})`)
		g.appendChild(g2)

		// Dumb mask fix thing
		const rect2 = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
		rect2.setAttribute('x', '-100')
		rect2.setAttribute('y', '-100')
		rect2.setAttribute('width', bounds.width + 200 + '')
		rect2.setAttribute('height', bounds.height + 200 + '')
		rect2.setAttribute('fill', 'transparent')
		rect2.setAttribute('stroke', 'none')
		g2.appendChild(rect2)

		// Arrowhead body path
		const path = getArrowSvgPath(
			info.isStraight ? getSolidStraightArrowPath(info) : getSolidCurvedArrowPath(info),
			color,
			strokeWidth
		)

		const { strokeDasharray, strokeDashoffset } = getPerfectDashProps(
			info.isStraight ? info.length : Math.abs(info.bodyArc.length),
			strokeWidth,
			{
				style: shape.props.dash,
			}
		)

		path.setAttribute('stroke-dasharray', strokeDasharray)
		path.setAttribute('stroke-dashoffset', strokeDashoffset)

		g2.appendChild(path)

		// Arrowhead start path
		if (as) {
			g.appendChild(
				getArrowheadSvgPath(
					as,
					shape.props.color,
					strokeWidth,
					shape.props.arrowheadStart === 'arrow' ? 'none' : shape.props.fill,
					colors
				)
			)
		}
		// Arrowhead end path
		if (ae) {
			g.appendChild(
				getArrowheadSvgPath(
					ae,
					shape.props.color,
					strokeWidth,
					shape.props.arrowheadEnd === 'arrow' ? 'none' : shape.props.fill,
					colors
				)
			)
		}

		// Text Label
		if (labelSize) {
			const opts = {
				fontSize: ARROW_LABEL_FONT_SIZES[shape.props.size],
				lineHeight: TEXT_PROPS.lineHeight,
				fontFamily: font,
				padding: 0,
				textAlign: 'middle' as const,
				width: labelSize.w - 8,
				verticalTextAlign: 'middle' as const,
				height: labelSize.h,
				fontStyle: 'normal',
				fontWeight: 'normal',
				overflow: 'wrap' as const,
			}

			const textElm = createTextSvgElementFromSpans(
				this.editor,
				this.editor.textMeasure.measureTextSpans(shape.props.text, opts),
				opts
			)
			textElm.setAttribute('fill', colors.fill[shape.props.labelColor])

			const children = Array.from(textElm.children) as unknown as SVGTSpanElement[]

			children.forEach((child) => {
				const x = parseFloat(child.getAttribute('x') || '0')
				const y = parseFloat(child.getAttribute('y') || '0')

				child.setAttribute('x', x + 4 + labelSize!.x + 'px')
				child.setAttribute('y', y + labelSize!.y + 'px')
			})

			const textBgEl = textElm.cloneNode(true) as SVGTextElement
			textBgEl.setAttribute('stroke-width', '2')
			textBgEl.setAttribute('fill', colors.background)
			textBgEl.setAttribute('stroke', colors.background)

			g.appendChild(textBgEl)
			g.appendChild(textElm)
		}

		return g
	}
}

function getArrowheadSvgMask(d: string, arrowhead: TLArrowheadType) {
	const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
	path.setAttribute('d', d)
	path.setAttribute('fill', arrowhead === 'arrow' ? 'none' : 'black')
	path.setAttribute('stroke', 'none')
	return path
}

function getArrowSvgPath(d: string, color: string, strokeWidth: number) {
	const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
	path.setAttribute('d', d)
	path.setAttribute('fill', 'none')
	path.setAttribute('stroke', color)
	path.setAttribute('stroke-width', strokeWidth + '')
	return path
}

function getArrowheadSvgPath(
	d: string,
	color: TLColorType,
	strokeWidth: number,
	fill: TLFillType,
	colors: TLExportColors
) {
	const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
	path.setAttribute('d', d)
	path.setAttribute('fill', 'none')
	path.setAttribute('stroke', colors.fill[color])
	path.setAttribute('stroke-width', strokeWidth + '')

	// Get the fill element, if any
	const shapeFill = getShapeFillSvg({
		d,
		fill,
		color,
		colors,
	})

	if (shapeFill) {
		// If there is a fill element, return a group containing the fill and the path
		const g = document.createElementNS('http://www.w3.org/2000/svg', 'g')
		g.appendChild(shapeFill)
		g.appendChild(path)
		return g
	} else {
		// Otherwise, just return the path
		return path
	}
}

function isPrecise(normalizedAnchor: Vec2dModel) {
	return normalizedAnchor.x !== 0.5 || normalizedAnchor.y !== 0.5
}
