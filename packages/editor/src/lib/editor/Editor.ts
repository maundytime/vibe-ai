import {
	getIndexAbove,
	getIndexBetween,
	getIndices,
	getIndicesAbove,
	getIndicesBetween,
	sortByIndex,
} from '@tldraw/indices'
import {
	Box2d,
	EASINGS,
	MatLike,
	Matrix2d,
	Matrix2dModel,
	PI2,
	Vec2d,
	VecLike,
	approximately,
	areAnglesCompatible,
	clamp,
	intersectPolygonPolygon,
	pointInPolygon,
} from '@tldraw/primitives'
import { ComputedCache, RecordType } from '@tldraw/store'
import {
	Box2dModel,
	CameraRecordType,
	InstancePageStateRecordType,
	PageRecordType,
	TLArrowShape,
	TLAsset,
	TLAssetId,
	TLAssetPartial,
	TLColorStyle,
	TLColorType,
	TLCursor,
	TLCursorType,
	TLDOCUMENT_ID,
	TLDocument,
	TLFrameShape,
	TLGroupShape,
	TLINSTANCE_ID,
	TLImageAsset,
	TLInstance,
	TLInstancePageState,
	TLNullableShapeProps,
	TLPOINTER_ID,
	TLPage,
	TLPageId,
	TLParentId,
	TLRecord,
	TLScribble,
	TLShape,
	TLShapeId,
	TLShapePartial,
	TLShapeProp,
	TLSizeStyle,
	TLStore,
	TLUnknownShape,
	TLVideoAsset,
	Vec2dModel,
	createShapeId,
	isPageId,
	isShape,
	isShapeId,
} from '@tldraw/tlschema'
import {
	annotateError,
	assert,
	compact,
	dedupe,
	deepCopy,
	getOwnProperty,
	hasOwnProperty,
	partition,
	sortById,
	structuredClone,
} from '@tldraw/utils'
import { EventEmitter } from 'eventemitter3'
import { nanoid } from 'nanoid'
import { EMPTY_ARRAY, atom, computed, transact } from 'signia'
import { TLUser, createTLUser } from '../config/createTLUser'
import { checkShapesAndAddCore } from '../config/defaultShapes'
import { AnyTLShapeInfo } from '../config/defineShape'
import {
	ANIMATION_MEDIUM_MS,
	BLACKLISTED_PROPS,
	COARSE_DRAG_DISTANCE,
	DEFAULT_ANIMATION_OPTIONS,
	DRAG_DISTANCE,
	FOLLOW_CHASE_PAN_SNAP,
	FOLLOW_CHASE_PAN_UNSNAP,
	FOLLOW_CHASE_PROPORTION,
	FOLLOW_CHASE_ZOOM_SNAP,
	FOLLOW_CHASE_ZOOM_UNSNAP,
	GRID_INCREMENT,
	HAND_TOOL_FRICTION,
	MAJOR_NUDGE_FACTOR,
	MAX_PAGES,
	MAX_SHAPES_PER_PAGE,
	MAX_ZOOM,
	MINOR_NUDGE_FACTOR,
	MIN_ZOOM,
	OPENAI_URL,
	SD_LOCAL_URL,
	SD_MAX,
	SD_MAX_RATIO,
	SD_MIN,
	SD_URL,
	STYLES,
	SVG_PADDING,
	ZOOMS,
} from '../constants'
import { exportPatternSvgDefs } from '../hooks/usePattern'
import { WeakMapCache } from '../utils/WeakMapCache'
import { dataUrlToFile } from '../utils/assets'
import { getIncrementedName, uniqueId } from '../utils/data'
import { setPropsForNextShape } from '../utils/props-for-next-shape'
import { applyRotationToSnapshotShapes, getRotationSnapshot } from '../utils/rotation'
import { arrowBindingsIndex } from './derivations/arrowBindingsIndex'
import { parentsToChildrenWithIndexes } from './derivations/parentsToChildrenWithIndexes'
import { shapeIdsInCurrentPage } from './derivations/shapeIdsInCurrentPage'
import { ActiveAreaManager, getActiveAreaScreenSpace } from './managers/ActiveAreaManager'
import { CameraManager } from './managers/CameraManager'
import { ClickManager } from './managers/ClickManager'
import { DprManager } from './managers/DprManager'
import { ExternalContentManager, TLExternalContent } from './managers/ExternalContentManager'
import { HistoryManager } from './managers/HistoryManager'
import { SnapManager } from './managers/SnapManager'
import { TextManager } from './managers/TextManager'
import { TickManager } from './managers/TickManager'
import { UserPreferencesManager } from './managers/UserPreferencesManager'
import { ShapeUtil, TLResizeMode } from './shapes/ShapeUtil'
import { ArrowShapeUtil } from './shapes/arrow/ArrowShapeUtil'
import { getCurvedArrowInfo } from './shapes/arrow/arrow/curved-arrow'
import { getArrowTerminalsInArrowSpace, getIsArrowStraight } from './shapes/arrow/arrow/shared'
import { getStraightArrowInfo } from './shapes/arrow/arrow/straight-arrow'
import { FrameShapeUtil } from './shapes/frame/FrameShapeUtil'
import { GroupShapeUtil } from './shapes/group/GroupShapeUtil'
import { TLExportColors } from './shapes/shared/TLExportColors'
import { TextShapeUtil } from './shapes/text/TextShapeUtil'
import { RootState } from './tools/RootState'
import { StateNode, TLStateNodeConstructor } from './tools/StateNode'
import { TLContent } from './types/clipboard-types'
import { TLEventMap } from './types/emit-types'
import { TLEventInfo, TLPinchEventInfo, TLPointerEventInfo } from './types/event-types'
import { RequiredKeys } from './types/misc-types'
import { TLResizeHandle } from './types/selection-types'

/** @public */
export type TLAnimationOptions = Partial<{
	duration: number
	easing: typeof EASINGS.easeInOutCubic
}>

/** @public */
export type TLViewportOptions = Partial<{
	/** Whether to animate the viewport change or not. Defaults to true. */
	stopFollowing: boolean
}>

/** @public */
export interface TLEditorOptions {
	/**
	 * The Store instance to use for keeping the app's data. This may be prepopulated, e.g. by loading
	 * from a server or database.
	 */
	store: TLStore
	/**
	 * An array of shapes to use in the editor. These will be used to create and manage shapes in the editor.
	 */
	shapes: readonly AnyTLShapeInfo[]
	/**
	 * An array of tools to use in the editor. These will be used to handle events and manage user interactions in the editor.
	 */
	tools: readonly TLStateNodeConstructor[]
	/**
	 * A user defined externally to replace the default user.
	 */
	user?: TLUser
	/**
	 * Should return a containing html element which has all the styles applied to the editor. If not
	 * given, the body element will be used.
	 */
	getContainer: () => HTMLElement
}

/** @public */
export class Editor extends EventEmitter<TLEventMap> {
	get isDev() {
		return process.env.NODE_ENV === 'development'
	}

	get openaiURL() {
		return OPENAI_URL
	}

	get sdURL() {
		return this.isDev ? SD_LOCAL_URL : SD_URL
	}

	get sdInterrogateModel() {
		return this.isDev ? 'deepdanbooru' : 'clip'
	}

	sdSetPreferSize = (value: { w: number; h: number }) => {
		this._sdPreferSize.set(value)
	}

	private _sdPreferSize = atom('sd size', { w: SD_MIN, h: SD_MIN })

	get sdSize() {
		let { w, h } = this._sdPreferSize.value
		if (w > h * SD_MAX_RATIO) {
			w = h * SD_MAX_RATIO
		} else if (h > w * SD_MAX_RATIO) {
			h = w * SD_MAX_RATIO
		}
		const isLandscape = w > h
		let max = Math.max(w, h)
		let min = Math.min(w, h)
		if (max > SD_MAX) {
			max = SD_MAX
			min = (SD_MAX * min) / max
		} else if (min < SD_MIN) {
			min = SD_MIN
			max = (SD_MIN * max) / min
		}
		return {
			sdRequestSize: {
				w: Math.round(isLandscape ? max : min),
				h: Math.round(isLandscape ? min : max),
			},
			properShapeSize: {
				w,
				h,
			},
		}
	}

	get sdcnParameterObject() {
		let p = {}
		try {
			p = { ...p, ...eval(`(${this._sdcnParameter.value})`) }
		} catch (e) {
			console.error(e)
		}
		return p
	}

	get sdcnParameter() {
		return this._sdcnParameter.value
	}

	set sdcnParameter(value: string) {
		this._sdcnParameter.set(value)
	}

	private _sdcnParameter = atom('sd parameter', '{}')

	get sdParameterObject() {
		let p = {
			negative_prompt: 'EasyNegative',
			steps: 20,
			cfg_scale: 7,
			sampler_name: 'DPM++ 2M Karras',
		}
		try {
			p = { ...p, ...eval(`(${this._sdParameter.value})`) }
		} catch (e) {
			console.error(e)
		}
		return p
	}

	get sdParameter() {
		return this._sdParameter.value
	}

	set sdParameter(value: string) {
		this._sdParameter.set(value)
	}

	private _sdParameter = atom(
		'sd parameter',
		this.isDev ? '{ seed: -1, steps: 10 }' : '{ seed: -1, steps: 20 }'
	)

	constructor({ store, user, shapes, tools, getContainer }: TLEditorOptions) {
		super()

		this.store = store

		this.user = new UserPreferencesManager(user ?? createTLUser())

		this.getContainer = getContainer ?? (() => document.body)

		this.textMeasure = new TextManager(this)

		this.root = new RootState(this)

		const allShapes = checkShapesAndAddCore(shapes)

		const shapeTypesInSchema = new Set(
			Object.keys(store.schema.types.shape.migrations.subTypeMigrations!)
		)
		for (const shape of allShapes) {
			if (!shapeTypesInSchema.has(shape.type)) {
				throw Error(
					`Editor and store have different shapes: "${shape.type}" was passed into the editor but not the schema`
				)
			}
			shapeTypesInSchema.delete(shape.type)
		}
		if (shapeTypesInSchema.size > 0) {
			throw Error(
				`Editor and store have different shapes: "${
					[...shapeTypesInSchema][0]
				}" is present in the store schema but not provided to the editor`
			)
		}
		this.shapeUtils = Object.fromEntries(
			allShapes.map(({ util: Util }) => [Util.type, new Util(this, Util.type)])
		)

		// Tools.
		// Accept tools from constructor parameters which may not conflict with the root note's default or
		// "baked in" tools, select and zoom.
		for (const { tool: Tool } of allShapes) {
			if (Tool) {
				if (hasOwnProperty(this.root.children!, Tool.id)) {
					throw Error(`Can't override tool with id "${Tool.id}"`)
				}
				this.root.children![Tool.id] = new Tool(this)
			}
		}
		for (const Tool of tools) {
			if (hasOwnProperty(this.root.children!, Tool.id)) {
				throw Error(`Can't override tool with id "${Tool.id}"`)
			}
			this.root.children![Tool.id] = new Tool(this)
		}

		if (typeof window !== 'undefined' && 'navigator' in window) {
			this.isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent)
			this.isIos = !!navigator.userAgent.match(/iPad/i) || !!navigator.userAgent.match(/iPhone/i)
			this.isChromeForIos = /crios.*safari/i.test(navigator.userAgent)
		} else {
			this.isSafari = false
			this.isIos = false
			this.isChromeForIos = false
		}

		// Set styles
		this.colors = new Map(Editor.styles.color.map((c) => [c.id, `var(--palette-${c.id})`]))

		this.store.onBeforeDelete = (record) => {
			if (record.typeName === 'shape') {
				this._shapeWillBeDeleted(record)
			} else if (record.typeName === 'page') {
				this._pageWillBeDeleted(record)
			}
		}

		this.store.onAfterChange = (prev, next) => {
			this._updateDepth++
			if (this._updateDepth > 1000) {
				console.error('[onAfterChange] Maximum update depth exceeded, bailing out.')
			}
			if (prev.typeName === 'shape' && next.typeName === 'shape') {
				this._shapeDidChange(prev, next)
			} else if (
				prev.typeName === 'instance_page_state' &&
				next.typeName === 'instance_page_state'
			) {
				this._pageStateDidChange(prev, next)
			}

			this._updateDepth--
		}
		this.store.onAfterCreate = (record) => {
			if (record.typeName === 'shape' && this.isShapeOfType(record, ArrowShapeUtil)) {
				this._arrowDidUpdate(record)
			}
			if (record.typeName === 'page') {
				const cameraId = CameraRecordType.createId(record.id)
				const pageStateId = InstancePageStateRecordType.createId(record.id)
				if (!this.store.has(cameraId)) {
					this.store.put([CameraRecordType.create({ id: cameraId })])
				}
				if (!this.store.has(pageStateId)) {
					this.store.put([
						InstancePageStateRecordType.create({ id: pageStateId, pageId: record.id }),
					])
				}
			}
		}

		this._shapeIds = shapeIdsInCurrentPage(this.store, () => this.currentPageId)
		this._parentIdsToChildIds = parentsToChildrenWithIndexes(this.store)

		this.disposables.add(
			this.store.listen((changes) => {
				this.emit('change', changes)
			})
		)

		const container = this.getContainer()
		const focusin = () => {
			this._isFocused.set(true)
		}
		const focusout = () => {
			this._isFocused.set(false)
		}

		container.addEventListener('focusin', focusin)
		container.addEventListener('focus', focusin)
		container.addEventListener('focusout', focusout)
		container.addEventListener('blur', focusout)

		this.disposables.add(() => {
			container.removeEventListener('focusin', focusin)
			container.removeEventListener('focus', focusin)
			container.removeEventListener('focusout', focusout)
			container.removeEventListener('blur', focusout)
		})

		this.store.ensureStoreIsUsable()

		// clear ephemeral state
		this.setInstancePageState(
			{
				editingId: null,
				hoveredId: null,
				erasingIds: [],
			},
			true
		)

		this.root.enter(undefined, 'initial')

		if (this.instanceState.followingUserId) {
			this.stopFollowingUser()
		}

		this.updateCullingBounds()

		requestAnimationFrame(() => {
			this._tickManager.start()
		})
	}

	/**
	 * The editor's store
	 *
	 * @public
	 */
	readonly store: TLStore

	/**
	 * The root state of the statechart.
	 *
	 * @public
	 */
	readonly root: RootState

	/**
	 * A cache of shape ids in the current page.
	 *
	 * @internal
	 */
	private readonly _shapeIds: ReturnType<typeof shapeIdsInCurrentPage>

	/**
	 * A set of functions to call when the app is disposed.
	 *
	 * @public
	 */
	readonly disposables = new Set<() => void>()

	/** @internal */
	private _dprManager = new DprManager(this)

	/** @internal */
	private _cameraManager = new CameraManager(this)

	/** @internal */
	private _activeAreaManager = new ActiveAreaManager(this)

	/** @internal */
	private _tickManager = new TickManager(this)

	/** @internal */
	private _updateDepth = 0

	/** @public */
	externalContentManager = new ExternalContentManager(this)

	/**
	 * A manager for the app's snapping feature.
	 *
	 * @public
	 */
	readonly snaps = new SnapManager(this)

	/**
	 * A manager for the user and their preferences.
	 *
	 * @public
	 */
	readonly user: UserPreferencesManager

	/**
	 * Whether the editor is running in Safari.
	 *
	 * @public
	 */
	readonly isSafari: boolean

	/**
	 * Whether the editor is running on iOS.
	 *
	 * @public
	 */
	readonly isIos: boolean

	/**
	 * Whether the editor is running on iOS.
	 *
	 * @public
	 */
	readonly isChromeForIos: boolean

	// Flags

	private _canMoveCamera = atom('can move camera', true)

	/**
	 * Whether the editor's camera can move.
	 *
	 * @example
	 * ```ts
	 * editor.canMoveCamera = false
	 * ```
	 *
	 * @param canMove - Whether the camera can move.
	 *
	 * @public
	 */
	get canMoveCamera() {
		return this._canMoveCamera.value
	}

	set canMoveCamera(canMove: boolean) {
		this._canMoveCamera.set(canMove)
	}

	private _isFocused = atom('_isFocused', false)

	/**
	 * Whether or not the editor is focused.
	 *
	 * @public
	 */
	get isFocused() {
		return this._isFocused.value
	}

	/**
	 * The current HTML element containing the editor.
	 *
	 * @example
	 * ```ts
	 * const container = editor.getContainer()
	 * ```
	 *
	 * @public
	 */
	getContainer: () => HTMLElement

	/** @internal */
	annotateError(
		error: unknown,
		{
			origin,
			willCrashApp,
			tags,
			extras,
		}: {
			origin: string
			willCrashApp: boolean
			tags?: Record<string, string | boolean | number>
			extras?: Record<string, unknown>
		}
	) {
		const defaultAnnotations = this.createErrorAnnotations(origin, willCrashApp)
		annotateError(error, {
			tags: { ...defaultAnnotations.tags, ...tags },
			extras: { ...defaultAnnotations.extras, ...extras },
		})
		if (willCrashApp) {
			this.store.markAsPossiblyCorrupted()
		}
	}

	/** @internal */
	createErrorAnnotations(
		origin: string,
		willCrashApp: boolean | 'unknown'
	): {
		tags: { origin: string; willCrashApp: boolean | 'unknown' }
		extras: {
			activeStateNode?: string
			selectedShapes?: TLUnknownShape[]
			editingShape?: TLUnknownShape
			inputs?: Record<string, unknown>
		}
	} {
		try {
			return {
				tags: {
					origin: origin,
					willCrashApp,
				},
				extras: {
					activeStateNode: this.root.path.value,
					selectedShapes: this.selectedShapes,
					editingShape: this.editingId ? this.getShapeById(this.editingId) : undefined,
					inputs: this.inputs,
				},
			}
		} catch {
			return {
				tags: {
					origin: origin,
					willCrashApp,
				},
				extras: {},
			}
		}
	}

	/** @internal */
	private _crashingError: unknown | null = null

	/**
	 * We can't use an `atom` here because there's a chance that when `crashAndReportError` is called,
	 * we're in a transaction that's about to be rolled back due to the same error we're currently
	 * reporting.
	 *
	 * Instead, to listen to changes to this value, you need to listen to app's `crash` event.
	 *
	 * @internal
	 */
	get crashingError() {
		return this._crashingError
	}

	/** @internal */
	crash(error: unknown) {
		this._crashingError = error
		this.store.markAsPossiblyCorrupted()
		this.emit('crash', { error })
	}

	/**
	 * The window's device pixel ratio.
	 *
	 * @public
	 */
	get devicePixelRatio() {
		return this._dprManager.dpr.value
	}

	private _openMenus = atom('open-menus', [] as string[])

	/**
	 * A set of strings representing any open menus. When menus are open,
	 * certain interactions will behave differently; for example, when a
	 * draw tool is selected and a menu is open, a pointer-down will not
	 * create a dot (because the user is probably trying to close the menu)
	 * however a pointer-down event followed by a drag will begin drawing
	 * a line (because the user is BOTH trying to close the menu AND start
	 * drawing a line).
	 *
	 * @public
	 */
	@computed get openMenus(): string[] {
		return this._openMenus.value
	}

	/**
	 * Add an open menu.
	 *
	 * @example
	 * ```ts
	 * editor.addOpenMenu('menu-id')
	 * ```
	 *
	 * @public
	 */
	addOpenMenu(id: string) {
		const menus = new Set(this.openMenus)
		if (!menus.has(id)) {
			menus.add(id)
			this._openMenus.set([...menus])
		}
		return this
	}

	/**
	 * Delete an open menu.
	 *
	 * @example
	 * ```ts
	 * editor.deleteOpenMenu('menu-id')
	 * ```
	 *
	 * @public
	 */
	deleteOpenMenu(id: string) {
		const menus = new Set(this.openMenus)
		if (menus.has(id)) {
			menus.delete(id)
			this._openMenus.set([...menus])
		}
		return this
	}

	/**
	 * Get whether any menus are open.
	 *
	 * @public
	 */
	@computed get isMenuOpen() {
		return this.openMenus.length > 0
	}

	/** @internal */
	private _isCoarsePointer = atom<boolean>('isCoarsePointer', false as any)

	/**
	 * Whether the user is using a "coarse" pointer, such as on a touch screen. This is automatically set by the canvas.
	 *
	 * @public
	 **/
	get isCoarsePointer() {
		return this._isCoarsePointer.value
	}

	set isCoarsePointer(v) {
		this._isCoarsePointer.set(v)
	}

	/** @internal */
	private _isChangingStyle = atom<boolean>('isChangingStyle', false as any)

	/** @internal */
	private _isChangingStyleTimeout = -1 as any

	/**
	 * Whether the user is currently changing the style of a shape. This may cause the UI to change.
	 *
	 * @example
	 * ```ts
	 * editor.isChangingStyle = true
	 * ```
	 *
	 * @public
	 */
	get isChangingStyle() {
		return this._isChangingStyle.value
	}

	set isChangingStyle(v) {
		this._isChangingStyle.set(v)
		// Clear any reset timeout
		clearTimeout(this._isChangingStyleTimeout)
		if (v) {
			// If we've set to true, set a new reset timeout to change the value back to false after 2 seconds
			this._isChangingStyleTimeout = setTimeout(() => (this.isChangingStyle = false), 2000)
		}
	}

	/**
	 * A cache of page transforms.
	 *
	 * @internal
	 */
	@computed private get _pageTransformCache(): ComputedCache<Matrix2d, TLShape> {
		return this.store.createComputedCache<Matrix2d, TLShape>('pageTransformCache', (shape) => {
			if (isPageId(shape.parentId)) {
				return this.getTransform(shape)
			}

			// If the shape's parent doesn't exist yet (e.g. when merging in changes from remote in the wrong order)
			// then we can't compute the transform yet, so just return the identity matrix.
			// In the future we should look at creating a store update mechanism that understands and preserves
			// ordering.
			const parent = this._pageTransformCache.get(shape.parentId) ?? Matrix2d.Identity()

			return Matrix2d.Compose(parent, this.getTransform(shape))
		})
	}

	/**
	 * A cache of axis aligned page bounding boxes.
	 *
	 * @internal
	 */
	@computed private get _pageBoundsCache(): ComputedCache<Box2d, TLShape> {
		return this.store.createComputedCache<Box2d, TLShape>('pageBoundsCache', (shape) => {
			const pageTransform = this._pageTransformCache.get(shape.id)

			if (!pageTransform) return new Box2d()

			const result = Box2d.FromPoints(
				Matrix2d.applyToPoints(pageTransform, this.getShapeUtil(shape).outline(shape))
			)

			return result
		})
	}

	/**
	 * A cache of page masks used for clipping.
	 *
	 * @internal
	 */
	@computed private get _pageMaskCache(): ComputedCache<VecLike[], TLShape> {
		return this.store.createComputedCache<VecLike[], TLShape>('pageMaskCache', (shape) => {
			if (isPageId(shape.parentId)) {
				return undefined
			}

			const frameAncestors = this.getAncestorsById(shape.id).filter((s) => s.type === 'frame')

			if (frameAncestors.length === 0) return undefined

			const pageMask = frameAncestors
				.map<VecLike[] | undefined>((s) =>
					// Apply the frame transform to the frame outline to get the frame outline in page space
					Matrix2d.applyToPoints(this._pageTransformCache.get(s.id)!, this.getOutline(s))
				)
				.reduce((acc, b) => (b && acc ? intersectPolygonPolygon(acc, b) ?? undefined : undefined))

			return pageMask
		})
	}

	/**
	 * Get the page mask for a shape.
	 *
	 * @example
	 * ```ts
	 * const pageMask = editor.getPageMaskById(shape.id)
	 * ```
	 *
	 * @param id - The id of the shape to get the page mask for.
	 *
	 * @returns The page mask for the shape.
	 *
	 * @public
	 */
	getPageMaskById(id: TLShapeId) {
		return this._pageMaskCache.get(id)
	}

	/**
	 * A cache of clip paths used for clipping.
	 *
	 * @internal
	 */
	@computed private get _clipPathCache(): ComputedCache<string, TLShape> {
		return this.store.createComputedCache<string, TLShape>('clipPathCache', (shape) => {
			const pageMask = this._pageMaskCache.get(shape.id)
			if (!pageMask) return undefined
			const pageTransform = this._pageTransformCache.get(shape.id)
			if (!pageTransform) return undefined

			if (pageMask.length === 0) {
				return `polygon(0px 0px, 0px 0px, 0px 0px)`
			}

			const localMask = Matrix2d.applyToPoints(Matrix2d.Inverse(pageTransform), pageMask)

			return `polygon(${localMask.map((p) => `${p.x}px ${p.y}px`).join(',')})`
		})
	}

	/**
	 * Get the clip path for a shape.
	 *
	 * @example
	 * ```ts
	 * const clipPath = editor.getClipPathById(shape.id)
	 * ```
	 *
	 * @param id - The shape id.
	 *
	 * @returns The clip path or undefined.
	 *
	 * @public
	 */
	getClipPathById(id: TLShapeId) {
		return this._clipPathCache.get(id)
	}

	/**
	 * A cache of parents to children.
	 *
	 * @internal
	 */
	private readonly _parentIdsToChildIds: ReturnType<typeof parentsToChildrenWithIndexes>

	/**
	 * Dispose the editor.
	 *
	 * @public
	 */
	dispose() {
		this.disposables.forEach((dispose) => dispose())
		this.disposables.clear()
	}

	/**
	 * A manager for the app's history.
	 *
	 * @readonly
	 */
	readonly history = new HistoryManager(
		this,
		() => this._complete(),
		(error) => {
			this.annotateError(error, { origin: 'history.batch', willCrashApp: true })
			this.crash(error)
		}
	)

	/**
	 * Undo to the last mark.
	 *
	 * @example
	 * ```ts
	 * editor.undo()
	 * ```
	 *
	 * @public
	 */
	undo() {
		return this.history.undo()
	}

	/**
	 * Whether the app can undo.
	 *
	 * @public
	 */
	@computed get canUndo() {
		return this.history.numUndos > 0
	}

	/**
	 * Redo to the next mark.
	 *
	 * @example
	 * ```ts
	 * editor.redo()
	 * ```
	 *
	 * @public
	 */
	redo() {
		this.history.redo()
		return this
	}

	/**
	 * Whether the app can redo.
	 *
	 * @public
	 */
	@computed get canRedo() {
		return this.history.numRedos > 0
	}

	/**
	 * Create a new "mark", or stopping point, in the undo redo history. Creating a mark will clear
	 * any redos.
	 *
	 * @example
	 * ```ts
	 * editor.mark()
	 * editor.mark('flip shapes')
	 * ```
	 *
	 * @param reason - The reason for the mark.
	 * @param onUndo - Whether to stop at the mark when undoing.
	 * @param onRedo - Whether to stop at the mark when redoing.
	 *
	 * @public
	 */
	mark(reason?: string, onUndo?: boolean, onRedo?: boolean) {
		return this.history.mark(reason, onUndo, onRedo)
	}

	/**
	 * Clear all marks in the undo stack back to the next mark.
	 *
	 * @example
	 * ```ts
	 * editor.bail()
	 * ```
	 *
	 * @public
	 */
	bail() {
		this.history.bail()
		return this
	}

	/**
	 * Clear all marks in the undo stack back to the mark with the provided mark id.
	 *
	 * @example
	 * ```ts
	 * editor.bailToMark('creating')
	 * ```
	 *
	 * @public
	 */
	bailToMark(id: string) {
		this.history.bailToMark(id)
		return this
	}

	/**
	 * Run a function in a batch, which will be undone/redone as a single action.
	 *
	 * @example
	 * ```ts
	 * editor.batch(() => {
	 * 	editor.selectAll()
	 * 	editor.deleteShapes()
	 * 	editor.createShapes(myShapes)
	 * 	editor.selectNone()
	 * })
	 *
	 * editor.undo() // will undo all of the above
	 * ```
	 *
	 * @public
	 */
	batch(fn: () => void) {
		this.history.batch(fn)
		return this
	}

	/**
	 * A map of shape utility classes (TLShapeUtils) by shape type.
	 *
	 * @public
	 */
	shapeUtils: { readonly [K in string]?: ShapeUtil<TLUnknownShape> }

	/**
	 * Get a shape util by its definition.
	 *
	 * @example
	 * ```ts
	 * editor.getShapeUtil(ArrowShapeUtil)
	 * ```
	 *
	 * @param util - The shape util.
	 *
	 * @public
	 */
	getShapeUtil<C extends { new (...args: any[]): ShapeUtil<any>; type: string }>(
		util: C
	): InstanceType<C>
	/**
	 * Get a shape util from a shape itself.
	 *
	 * @example
	 * ```ts
	 * const util = editor.getShapeUtil(myShape)
	 * const util = editor.getShapeUtil<ArrowShapeUtil>(myShape)
	 * const util = editor.getShapeUtil(ArrowShapeUtil)
	 * ```
	 *
	 * @param shape - A shape or shape partial.
	 *
	 * @public
	 */
	getShapeUtil<S extends TLUnknownShape>(shape: S | TLShapePartial<S>): ShapeUtil<S>
	getShapeUtil<T extends ShapeUtil>(shapeUtilConstructor: {
		type: T extends ShapeUtil<infer R> ? R['type'] : string
	}): T {
		const shapeUtil = getOwnProperty(this.shapeUtils, shapeUtilConstructor.type) as T | undefined
		assert(shapeUtil, `No shape util found for type "${shapeUtilConstructor.type}"`)

		// does shapeUtilConstructor extends ShapeUtil?
		if (
			'prototype' in shapeUtilConstructor &&
			shapeUtilConstructor.prototype instanceof ShapeUtil
		) {
			assert(
				shapeUtil instanceof (shapeUtilConstructor as any),
				`Shape util found for type "${shapeUtilConstructor.type}" is not an instance of the provided constructor`
			)
		}

		return shapeUtil as T
	}

	/**
	 * A cache of children for each parent.
	 *
	 * @internal
	 */
	private _childIdsCache = new WeakMapCache<any[], TLShapeId[]>()

	/**
	 * Get an array of all the children of a shape.
	 *
	 * @example
	 * ```ts
	 * editor.getSortedChildIds('frame1')
	 * ```
	 *
	 * @param parentId - The id of the parent shape.
	 *
	 * @public
	 */
	getSortedChildIds(parentId: TLParentId): TLShapeId[] {
		const withIndices = this._parentIdsToChildIds.value[parentId]
		if (!withIndices) return EMPTY_ARRAY
		return this._childIdsCache.get(withIndices, () => withIndices.map(([id]) => id))
	}
	/**
	 * Run a visitor function for all descendants of a shape.
	 *
	 * @example
	 * ```ts
	 * editor.visitDescendants('frame1', myCallback)
	 * ```
	 *
	 * @param parentId - The id of the parent shape.
	 * @param visitor - The visitor function.
	 *
	 * @public
	 */
	visitDescendants(parentId: TLParentId, visitor: (id: TLShapeId) => void | false) {
		const children = this.getSortedChildIds(parentId)
		for (const id of children) {
			if (visitor(id) === false) continue
			this.visitDescendants(id, visitor)
		}
	}

	/**
	 * The editor's current erasing ids.
	 *
	 * @public
	 */
	@computed get erasingIds() {
		return this.pageState.erasingIds
	}

	/**
	 * The editor's current hinting ids.
	 *
	 * @public
	 */
	@computed get hintingIds() {
		return this.pageState.hintingIds
	}

	/**
	 * A derived set containing the current erasing ids.
	 *
	 * @public
	 */
	@computed get erasingIdsSet() {
		// todo: Make incremental derivation, so that this only gets updated when erasingIds changes: we're creating this too often!
		return new Set<TLShapeId>(this.erasingIds)
	}

	/**
	 * Get all the current props among the users selected shapes
	 *
	 * @internal
	 */
	private _extractSharedProps(shape: TLShape, sharedProps: TLNullableShapeProps) {
		if (shape.type === 'group') {
			// For groups, ignore the props of the group shape and instead include
			// the props of the group's children. These are the shapes that would have
			// their props changed if the user called `setProp` on the current selection.
			const childIds = this._parentIdsToChildIds.value[shape.id]
			if (!childIds) return

			for (let i = 0, n = childIds.length; i < n; i++) {
				this._extractSharedProps(this.getShapeById(childIds[i][0])!, sharedProps)
			}
		} else {
			const props = Object.entries(shape.props)
			let prop: [TLShapeProp, any]
			for (let i = 0, n = props.length; i < n; i++) {
				prop = props[i] as [TLShapeProp, any]

				// We should probably white list rather than black list here
				if (BLACKLISTED_PROPS.has(prop[0])) continue

				// Check the value of this prop on the shared props object.
				switch (sharedProps[prop[0]]) {
					case undefined: {
						// If this key hasn't been defined yet in the shared props object,
						// we can set it to the value from the shape's props object.
						sharedProps[prop[0]] = prop[1]
						break
					}
					case null:
					case prop[1]: {
						// If the value in the shared props object matches the value from
						// the shape's props object exactly—or if there is already a mixed
						// value (null) in the shared props object—then this is a noop. We
						// want to leave the value as it is in the shared props object.
						continue
					}
					default: {
						// If there's a value in the shared props object that isn't null AND
						// that isn't undefined AND that doesn't match the shape's props object,
						// then we've got a conflict, mixed props, so set the value to null.
						sharedProps[prop[0]] = null
					}
				}
			}
		}
	}

	/**
	 * A derived object containing all current props among the user's selected shapes.
	 *
	 * @internal
	 */
	private _selectionSharedProps = computed<TLNullableShapeProps>('_selectionSharedProps', () => {
		const { selectedShapes } = this

		const sharedProps = {} as TLNullableShapeProps

		for (let i = 0, n = selectedShapes.length; i < n; i++) {
			this._extractSharedProps(selectedShapes[i], sharedProps)
		}

		return sharedProps as TLNullableShapeProps
	})

	/** @internal */
	private _prevProps: any = {}

	/**
	 * A derived object containing either all current props among the user's selected shapes, or else
	 * the user's most recent prop choices that correspond to the current active state (i.e. the
	 * selected tool).
	 *
	 * @internal
	 */
	@computed get props(): TLNullableShapeProps | null {
		let next: TLNullableShapeProps | null

		// If we're in selecting and if we have a selection,
		// return the shared props from the current selection
		if (this.isIn('select') && this.selectedIds.length > 0) {
			next = this._selectionSharedProps.value
		} else {
			// Otherwise, pull the style props from the app state
			// (the most recent choices made by the user) that are
			// exposed by the current state (i.e. the active tool).
			const currentState = this.root.current.value!
			if (currentState.styles.length === 0) {
				next = null
			} else {
				const { propsForNextShape } = this.instanceState
				next = Object.fromEntries(
					currentState.styles.map((k) => {
						return [k, propsForNextShape[k]]
					})
				)
			}
		}

		// todo: any way to improve this? still faster than rendering the style panel every frame
		if (JSON.stringify(this._prevProps) === JSON.stringify(next)) {
			return this._prevProps
		}

		this._prevProps = next

		return next
	}

	/**
	 * Get the currently selected opacity.
	 * If any shapes are selected, this returns the opacity of the selected shapes.
	 * Otherwise, this returns the chosen opacity for the next shape.
	 *
	 * @public
	 */
	@computed get opacity(): number | null {
		if (this.isIn('select') && this.selectedIds.length > 0) {
			const shapesToCheck: TLShape[] = []
			const addShape = (shapeId: TLShapeId) => {
				const shape = this.getShapeById(shapeId)
				if (!shape) return
				// For groups, ignore the opacity of the group shape and instead include
				// the opacity of the group's children. These are the shapes that would have
				// their opacity changed if the user called `setOpacity` on the current selection.
				if (shape.type === 'group') {
					for (const childId of this.getSortedChildIds(shape.id)) {
						addShape(childId)
					}
				} else {
					shapesToCheck.push(shape)
				}
			}
			for (const shapeId of this.selectedIds) {
				addShape(shapeId)
			}

			let opacity: number | null = null
			for (const shape of shapesToCheck) {
				if (opacity === null) {
					opacity = shape.opacity
				} else if (opacity !== shape.opacity) {
					return null
				}
			}

			return opacity
		} else {
			return this.instanceState.opacityForNextShape
		}
	}

	/**
	 * An array of all of the shapes on the current page.
	 *
	 * @public
	 */
	get shapeIds() {
		return this._shapeIds.value
	}

	/**
	 * _invalidParents is used to trigger the 'onChildrenChange' callback that shapes can have.
	 *
	 * @internal
	 */
	private readonly _invalidParents = new Set<TLShapeId>()

	/** @internal */
	private _complete() {
		for (const parentId of this._invalidParents) {
			this._invalidParents.delete(parentId)
			const parent = this.getShapeById(parentId)
			if (!parent) continue

			const util = this.getShapeUtil(parent)
			const changes = util.onChildrenChange?.(parent)

			if (changes?.length) {
				this.updateShapes(changes, true)
			}
		}

		this.emit('update')
	}

	/** @internal */
	@computed
	private get _arrowBindingsIndex() {
		return arrowBindingsIndex(this.store)
	}

	/**
	 * Get all arrows bound to a shape.
	 *
	 * @param shapeId - The id of the shape.
	 *
	 * @public
	 */
	getArrowsBoundTo(shapeId: TLShapeId) {
		return this._arrowBindingsIndex.value[shapeId] || EMPTY_ARRAY
	}

	/** @internal */
	private _reparentArrow(arrowId: TLShapeId) {
		const arrow = this.getShapeById<TLArrowShape>(arrowId)
		if (!arrow) return
		const { start, end } = arrow.props
		const startShape = start.type === 'binding' ? this.getShapeById(start.boundShapeId) : undefined
		const endShape = end.type === 'binding' ? this.getShapeById(end.boundShapeId) : undefined

		const parentPageId = this.getParentPageId(arrow)
		if (!parentPageId) return

		let nextParentId: TLParentId
		if (startShape && endShape) {
			// if arrow has two bindings, always parent arrow to closest common ancestor of the bindings
			nextParentId = this.findCommonAncestor([startShape, endShape]) ?? parentPageId
		} else if (startShape || endShape) {
			// if arrow has one binding, keep arrow on its own page
			nextParentId = parentPageId
		} else {
			return
		}

		if (nextParentId && nextParentId !== arrow.parentId) {
			this.reparentShapesById([arrowId], nextParentId)
		}

		const reparentedArrow = this.getShapeById<TLArrowShape>(arrowId)
		if (!reparentedArrow) throw Error('no reparented arrow')

		const startSibling = this.getNearestSiblingShape(reparentedArrow, startShape)
		const endSibling = this.getNearestSiblingShape(reparentedArrow, endShape)

		let highestSibling: TLShape | undefined

		if (startSibling && endSibling) {
			highestSibling = startSibling.index > endSibling.index ? startSibling : endSibling
		} else if (startSibling && !endSibling) {
			highestSibling = startSibling
		} else if (endSibling && !startSibling) {
			highestSibling = endSibling
		} else {
			return
		}

		let finalIndex: string

		const higherSiblings = this.getSortedChildIds(highestSibling.parentId)
			.map((id) => this.getShapeById(id)!)
			.filter((sibling) => sibling.index > highestSibling!.index)

		if (higherSiblings.length) {
			// there are siblings above the highest bound sibling, we need to
			// insert between them.

			// if the next sibling is also a bound arrow though, we can end up
			// all fighting for the same indexes. so lets find the next
			// non-arrow sibling...
			const nextHighestNonArrowSibling = higherSiblings.find((sibling) => sibling.type !== 'arrow')

			if (
				// ...then, if we're above the last shape we want to be above...
				reparentedArrow.index > highestSibling.index &&
				// ...but below the next non-arrow sibling...
				(!nextHighestNonArrowSibling || reparentedArrow.index < nextHighestNonArrowSibling.index)
			) {
				// ...then we're already in the right place. no need to update!
				return
			}

			// otherwise, we need to find the index between the highest sibling
			// we want to be above, and the next highest sibling we want to be
			// below:
			finalIndex = getIndexBetween(highestSibling.index, higherSiblings[0].index)
		} else {
			// if there are no siblings above us, we can just get the next index:
			finalIndex = getIndexAbove(highestSibling.index)
		}

		if (finalIndex !== reparentedArrow.index) {
			this.updateShapes<TLArrowShape>([{ id: arrowId, type: 'arrow', index: finalIndex }])
		}
	}

	/** @internal */
	private _unbindArrowTerminal(arrow: TLArrowShape, handleId: 'start' | 'end') {
		const { x, y } = getArrowTerminalsInArrowSpace(this, arrow)[handleId]
		this.store.put([{ ...arrow, props: { ...arrow.props, [handleId]: { type: 'point', x, y } } }])
	}

	// private _shapeWillUpdate = (prev: TLShape, next: TLShape) => {
	// 	const update = this.getShapeUtil(next).onUpdate?.(prev, next)
	// 	return update ?? next
	// }

	@computed
	private get _allPageStates() {
		return this.store.query.records('instance_page_state')
	}

	/** @internal */
	private _shapeWillBeDeleted(deletedShape: TLShape) {
		// if the deleted shape has a parent shape make sure we call it's onChildrenChange callback
		if (deletedShape.parentId && isShapeId(deletedShape.parentId)) {
			this._invalidParents.add(deletedShape.parentId)
		}
		// clean up any arrows bound to this shape
		const bindings = this._arrowBindingsIndex.value[deletedShape.id]
		if (bindings?.length) {
			for (const { arrowId, handleId } of bindings) {
				const arrow = this.getShapeById<TLArrowShape>(arrowId)
				if (!arrow) continue
				this._unbindArrowTerminal(arrow, handleId)
			}
		}
		const pageStates = this._allPageStates.value

		const deletedIds = new Set([deletedShape.id])
		const updates = compact(
			pageStates.map((pageState) => {
				return this._cleanupInstancePageState(pageState, deletedIds)
			})
		)

		if (updates.length) {
			this.store.put(updates)
		}
	}

	/** @internal */
	private _arrowDidUpdate(arrow: TLArrowShape) {
		// if the shape is an arrow and its bound shape is on another page
		// or was deleted, unbind it
		for (const handle of ['start', 'end'] as const) {
			const terminal = arrow.props[handle]
			if (terminal.type !== 'binding') continue
			const boundShape = this.getShapeById(terminal.boundShapeId)
			const isShapeInSamePageAsArrow =
				this.getParentPageId(arrow) === this.getParentPageId(boundShape)
			if (!boundShape || !isShapeInSamePageAsArrow) {
				this._unbindArrowTerminal(arrow, handle)
			}
		}

		// always check the arrow parents
		this._reparentArrow(arrow.id)
	}

	/** @internal */
	private _cleanupInstancePageState(
		prevPageState: TLInstancePageState,
		shapesNoLongerInPage: Set<TLShapeId>
	) {
		let nextPageState = null as null | TLInstancePageState

		const selectedIds = prevPageState.selectedIds.filter((id) => !shapesNoLongerInPage.has(id))
		if (selectedIds.length !== prevPageState.selectedIds.length) {
			if (!nextPageState) nextPageState = { ...prevPageState }
			nextPageState.selectedIds = selectedIds
		}

		const erasingIds = prevPageState.erasingIds.filter((id) => !shapesNoLongerInPage.has(id))
		if (erasingIds.length !== prevPageState.erasingIds.length) {
			if (!nextPageState) nextPageState = { ...prevPageState }
			nextPageState.erasingIds = erasingIds
		}

		if (prevPageState.hoveredId && shapesNoLongerInPage.has(prevPageState.hoveredId)) {
			if (!nextPageState) nextPageState = { ...prevPageState }
			nextPageState.hoveredId = null
		}

		if (prevPageState.editingId && shapesNoLongerInPage.has(prevPageState.editingId)) {
			if (!nextPageState) nextPageState = { ...prevPageState }
			nextPageState.editingId = null
		}

		const hintingIds = prevPageState.hintingIds.filter((id) => !shapesNoLongerInPage.has(id))
		if (hintingIds.length !== prevPageState.hintingIds.length) {
			if (!nextPageState) nextPageState = { ...prevPageState }
			nextPageState.hintingIds = hintingIds
		}

		if (prevPageState.focusLayerId && shapesNoLongerInPage.has(prevPageState.focusLayerId)) {
			if (!nextPageState) nextPageState = { ...prevPageState }
			nextPageState.focusLayerId = null
		}
		return nextPageState
	}

	/** @internal */
	private _shapeDidChange(prev: TLShape, next: TLShape) {
		if (this.isShapeOfType(next, ArrowShapeUtil)) {
			this._arrowDidUpdate(next)
		}

		// if the shape's parent changed and it is bound to an arrow, update the arrow's parent
		if (prev.parentId !== next.parentId) {
			const reparentBoundArrows = (id: TLShapeId) => {
				const boundArrows = this._arrowBindingsIndex.value[id]
				if (boundArrows?.length) {
					for (const arrow of boundArrows) {
						this._reparentArrow(arrow.arrowId)
					}
				}
			}
			reparentBoundArrows(next.id)
			this.visitDescendants(next.id, reparentBoundArrows)
		}

		// if this shape moved to a new page, clean up any previous page's instance state
		if (prev.parentId !== next.parentId && isPageId(next.parentId)) {
			const allMovingIds = new Set([prev.id])
			this.visitDescendants(prev.id, (id) => {
				allMovingIds.add(id)
			})

			for (const instancePageState of this._allPageStates.value) {
				if (instancePageState.pageId === next.parentId) continue
				const nextPageState = this._cleanupInstancePageState(instancePageState, allMovingIds)

				if (nextPageState) {
					this.store.put([nextPageState])
				}
			}
		}

		if (prev.parentId && isShapeId(prev.parentId)) {
			this._invalidParents.add(prev.parentId)
		}

		if (next.parentId !== prev.parentId && isShapeId(next.parentId)) {
			this._invalidParents.add(next.parentId)
		}
	}

	/** @internal */
	private _pageStateDidChange(prev: TLInstancePageState, next: TLInstancePageState) {
		if (prev?.selectedIds !== next?.selectedIds) {
			// ensure that descendants and ancestors are not selected at the same time
			const filtered = next.selectedIds.filter((id) => {
				let parentId = this.getShapeById(id)?.parentId
				while (isShapeId(parentId)) {
					if (next.selectedIds.includes(parentId)) {
						return false
					}
					parentId = this.getShapeById(parentId)?.parentId
				}
				return true
			})

			const nextFocusLayerId =
				filtered.length === 0
					? next?.focusLayerId
					: this.findCommonAncestor(
							compact(filtered.map((id) => this.getShapeById(id))),
							(shape) => shape.type === 'group'
					  )

			if (filtered.length !== next.selectedIds.length || nextFocusLayerId != next.focusLayerId) {
				this.store.put([{ ...next, selectedIds: filtered, focusLayerId: nextFocusLayerId ?? null }])
			}
		}
	}

	/** @internal */
	private _pageWillBeDeleted(page: TLPage) {
		// page was deleted, need to check whether it's the current page and select another one if so
		if (this.instanceState.currentPageId !== page.id) return

		const backupPageId = this.pages.find((p) => p.id !== page.id)?.id
		if (!backupPageId) return
		this.store.put([{ ...this.instanceState, currentPageId: backupPageId }])

		// delete the camera and state for the page if necessary
		const cameraId = CameraRecordType.createId(page.id)
		const instancePageStateId = InstancePageStateRecordType.createId(page.id)
		this.store.remove([cameraId, instancePageStateId])
	}

	/* -------------------- Shortcuts ------------------- */

	/**
	 * The global document settings that apply to all users.
	 *
	 * @public
	 **/
	@computed get documentSettings() {
		return this.store.get(TLDOCUMENT_ID)!
	}

	/**
	 * Update the global document settings that apply to all users.
	 *
	 * @public
	 **/
	updateDocumentSettings(settings: Partial<TLDocument>) {
		this.store.put([{ ...this.documentSettings, ...settings }])
	}

	/**
	 * The document's grid size.
	 *
	 * @public
	 **/
	get gridSize() {
		return this.documentSettings.gridSize
	}

	/** @internal */
	get projectName() {
		return this.documentSettings.name
	}

	/** @internal */
	setProjectName(name: string) {
		this.updateDocumentSettings({ name })
	}

	/**
	 * Whether the user has "always snap" mode enabled.
	 *
	 * @public
	 **/
	get isSnapMode() {
		return this.user.isSnapMode
	}

	/**
	 * Set whether the user has "always snap" mode enabled.
	 *
	 * @public
	 **/
	setSnapMode(isSnapMode: boolean) {
		if (isSnapMode !== this.isSnapMode) {
			this.user.updateUserPreferences({ isSnapMode })
		}
		return this
	}

	/**
	 * Whether the user has dark mode enabled.
	 *
	 * @public
	 **/
	get isDarkMode() {
		return this.user.isDarkMode
	}

	/**
	 * Set whether the user has dark mode enabled.
	 *
	 * @public
	 **/
	setDarkMode(isDarkMode: boolean) {
		if (isDarkMode !== this.isDarkMode) {
			this.user.updateUserPreferences({ isDarkMode })
		}
		return this
	}

	/**
	 * The user's chosen animation speed.
	 *
	 * @public
	 */
	get animationSpeed() {
		return this.user.animationSpeed
	}

	/**
	 * Set the user's chosen animation speed.
	 * Set to 0.0 to disable animations.
	 * Set to 1.0 for full speed.
	 *
	 * @public
	 */
	setAnimationSpeed(animationSpeed: number): this {
		if (animationSpeed !== this.animationSpeed) {
			this.user.updateUserPreferences({ animationSpeed })
		}
		return this
	}

	/**
	 * Whether the instance is in focus mode or not.
	 *
	 * @public
	 **/
	get isFocusMode() {
		return this.instanceState.isFocusMode
	}

	/**
	 * Set whether the instance is in focus mode or not.
	 *
	 * @public
	 **/
	setFocusMode(isFocusMode: boolean): this {
		if (isFocusMode !== this.isFocusMode) {
			this.updateInstanceState({ isFocusMode }, true)
		}
		return this
	}

	/**
	 * Whether the instance has "tool lock" mode enabled.
	 *
	 * @public
	 **/
	get isToolLocked() {
		return this.instanceState.isToolLocked
	}

	/**
	 * Set whether the instance has "tool lock" mode enabled.
	 *
	 * @public
	 **/
	setToolLocked(isToolLocked: boolean): this {
		if (isToolLocked !== this.isToolLocked) {
			this.updateInstanceState({ isToolLocked }, true)
		}
		return this
	}

	/**
	 * Whether the instance's grid is enabled.
	 *
	 * @public
	 **/
	get isGridMode() {
		return this.instanceState.isGridMode
	}

	/**
	 * Set whether the instance's grid is enabled.
	 *
	 * @public
	 **/
	setGridMode(isGridMode: boolean): this {
		if (isGridMode !== this.isGridMode) {
			this.updateInstanceState({ isGridMode }, true)
		}
		return this
	}

	private _isReadOnly = atom<boolean>('isReadOnly', false as any)

	/**
	 * Set whether the editor is in read-only mode or not.
	 *
	 * @public
	 **/
	setReadOnly(isReadOnly: boolean): this {
		this._isReadOnly.set(isReadOnly)
		if (isReadOnly) {
			this.setSelectedTool('hand')
		}
		return this
	}

	/**
	 * Whether the editor is in read-only mode or not.
	 *
	 * @public
	 **/
	get isReadOnly() {
		return this._isReadOnly.value
	}

	/** @internal */
	private _isPenMode = atom<boolean>('isPenMode', false as any)

	/** @internal */
	private _touchEventsRemainingBeforeExitingPenMode = 0

	/**
	 * Whether the editor is in pen mode or not.
	 *
	 * @public
	 **/
	get isPenMode() {
		return this._isPenMode.value
	}

	/**
	 * Set whether the editor is in pen mode or not.
	 *
	 * @public
	 **/
	setPenMode(isPenMode: boolean): this {
		if (isPenMode) this._touchEventsRemainingBeforeExitingPenMode = 3
		if (isPenMode !== this.isPenMode) {
			this._isPenMode.set(isPenMode)
		}
		return this
	}

	// User / User App State

	/**
	 * The current instance's state.
	 *
	 * @public
	 */
	get instanceState(): TLInstance {
		return this.store.get(TLINSTANCE_ID)!
	}

	/**
	 * The instance's cursor state.
	 *
	 * @public
	 **/
	get cursor() {
		return this.instanceState.cursor
	}

	/**
	 * The instance's brush state.
	 *
	 * @public
	 **/
	get brush() {
		return this.instanceState.brush
	}

	/**
	 * The instance's zoom brush state.
	 *
	 * @public
	 **/
	get zoomBrush() {
		return this.instanceState.zoomBrush
	}

	/**
	 * The instance's scribble state.
	 *
	 * @public
	 **/
	get scribble() {
		return this.instanceState.scribble
	}

	/** @internal */
	@computed private get pageStateId() {
		return InstancePageStateRecordType.createId(this.currentPageId)
	}

	/**
	 * The current page state.
	 *
	 * @public
	 */
	@computed get pageState(): TLInstancePageState {
		return this.store.get(this.pageStateId)!
	}

	/** @internal */
	@computed
	private get cameraId() {
		return CameraRecordType.createId(this.currentPageId)
	}

	/**
	 * The current camera.
	 *
	 * @public
	 */
	@computed get camera() {
		return this.store.get(this.cameraId)!
	}

	/**
	 * The current camera zoom level.
	 *
	 * @public
	 */
	@computed get zoomLevel() {
		return this.camera.z
	}

	/**
	 * The current selected ids.
	 *
	 * @public
	 */
	@computed get selectedIds() {
		return this.pageState.selectedIds
	}

	/**
	 * The current selected ids as a set
	 *
	 * @public
	 */
	@computed get selectedIdsSet(): ReadonlySet<TLShapeId> {
		return new Set(this.selectedIds)
	}

	/** @internal */
	@computed private get _pages() {
		return this.store.query.records('page')
	}

	/**
	 * Info about the project's current pages.
	 *
	 * @public
	 */
	@computed get pages() {
		return this._pages.value.sort(sortByIndex)
	}

	/**
	 * The current page.
	 *
	 * @public
	 */
	get currentPage() {
		return this.getPageById(this.currentPageId)!
	}

	/**
	 * The current page id.
	 *
	 * @public
	 */
	get currentPageId() {
		return this.instanceState.currentPageId
	}

	/**
	 * Get a page by its ID.
	 *
	 * @example
	 * ```ts
	 * editor.getPageById(myPage.id)
	 * ```
	 *
	 * @public
	 */
	getPageById(id: TLPageId) {
		return this.store.get(id)
	}

	/** @internal */
	@computed private get _pageStates() {
		return this.store.query.records('instance_page_state')
	}

	/**
	 * Get a page state by its id.
	 *
	 * @example
	 * ```ts
	 * editor.getPageStateByPageId('page1')
	 * ```
	 *
	 * @public
	 */
	getPageStateByPageId(id: TLPageId) {
		return this._pageStates.value.find((p) => p.pageId === id)
	}

	/**
	 * Get a page by its ID.
	 *
	 * @example
	 * ```ts
	 * editor.getPageById(myPage.id)
	 * ```
	 *
	 * @public
	 */
	getPageInfoById(id: TLPage['id']) {
		return this.store.get(id)
	}

	/**
	 * Get the ids of shapes on a page.
	 *
	 * @param pageId - The id of the page.
	 *
	 * @public
	 **/
	getShapeIdsInPage(pageId: TLPageId): Set<TLShapeId> {
		const result = this.store.query.exec('shape', { parentId: { eq: pageId } })
		return this.getShapeAndDescendantIds(result.map((s) => s.id))
	}

	/* --------------------- Shapes --------------------- */

	/**
	 * Get the local transform for a shape as a matrix model. This transform reflects both its
	 * translation (x, y) from from either its parent's top left corner, if the shape's parent is
	 * another shape, or else from the 0,0 of the page, if the shape's parent is the page; and the
	 * shape's rotation.
	 *
	 * @example
	 * ```ts
	 * editor.getTransform(myShape)
	 * ```
	 *
	 * @param shape - The shape to get the local transform for.
	 *
	 * @public
	 */
	getTransform(shape: TLShape) {
		const util = this.getShapeUtil(shape)
		return util.transform(shape)
	}

	/**
	 * Get the local transform of a shape's parent as a matrix model.
	 *
	 * @example
	 * ```ts
	 * editor.getParentTransform(myShape)
	 * ```
	 *
	 * @param shape - The shape to get the parent transform for.
	 *
	 * @public
	 */
	getParentTransform(shape: TLShape) {
		if (isPageId(shape.parentId)) {
			return Matrix2d.Identity()
		}
		return this._pageTransformCache.get(shape.parentId) ?? Matrix2d.Identity()
	}

	/**
	 * Get the page transform (or absolute transform) of a shape.
	 *
	 * @example
	 * ```ts
	 * editor.getPageTransform(myShape)
	 * ```
	 *
	 * @param shape - The shape to get the page transform for.
	 *
	 * @public
	 */
	getPageTransform(shape: TLShape) {
		return this.getPageTransformById(shape.id)
	}

	/**
	 * Get the page transform (or absolute transform) of a shape by its id.
	 *
	 * @example
	 * ```ts
	 * editor.getPageTransformById(myShape)
	 * ```
	 *
	 * @param id - The if of the shape to get the page transform for.
	 *
	 * @public
	 */
	getPageTransformById(id: TLShapeId) {
		return this._pageTransformCache.get(id)
	}

	/**
	 * Get the page point (or absolute point) of a shape.
	 *
	 * @example
	 * ```ts
	 * editor.getPagePoint(myShape)
	 * ```
	 *
	 * @param shape - The shape to get the page point for.
	 *
	 * @public
	 */
	getPagePointById(id: TLShapeId) {
		const pageTransform = this.getPageTransformById(id)
		if (!pageTransform) return
		return Matrix2d.applyToPoint(pageTransform, new Vec2d())
	}

	/**
	 * Get the page point (or absolute point) of a shape.
	 *
	 * @example
	 * ```ts
	 * editor.getPagePoint(myShape)
	 * ```
	 *
	 * @param shape - The shape to get the page point for.
	 *
	 * @public
	 */
	getPageCenter(shape: TLShape) {
		const pageTransform = this.getPageTransformById(shape.id)
		if (!pageTransform) return null
		const util = this.getShapeUtil(shape)
		const center = util.center(shape)
		return Matrix2d.applyToPoint(pageTransform, center)
	}

	/**
	 * Get the page point (or absolute point) of a shape by its id.
	 *
	 * @example
	 * ```ts
	 * editor.getPagePoint(myShape)
	 * ```
	 *
	 * @param id - The shape id to get the page point for.
	 *
	 * @public
	 */
	getPageCenterById(id: TLShapeId) {
		const shape = this.getShapeById(id)!
		return this.getPageCenter(shape)
	}

	/**
	 * Get the page rotation (or absolute rotation) of a shape.
	 *
	 * @example
	 * ```ts
	 * editor.getPageRotation(myShape)
	 * ```
	 *
	 * @param shape - The shape to get the page rotation for.
	 *
	 * @public
	 */
	getPageRotation(shape: TLShape): number {
		return this.getPageRotationById(shape.id)
	}

	/**
	 * Get the page rotation (or absolute rotation) of a shape by its id.
	 *
	 * @example
	 * ```ts
	 * editor.getPageRotationById(myShapeId)
	 * ```
	 *
	 * @param id - The id of the shape to get the page rotation for.
	 */
	getPageRotationById(id: TLShapeId): number {
		const pageTransform = this.getPageTransformById(id)
		if (pageTransform) {
			return Matrix2d.Decompose(pageTransform).rotation
		}
		return 0
	}

	/**
	 * Get the local bounds of a shape.
	 *
	 * @example
	 * ```ts
	 * editor.getBounds(myShape)
	 * ```
	 *
	 * @param shape - The shape to get the bounds for.
	 *
	 * @public
	 */
	getBounds(shape: TLShape): Box2d {
		return this.getShapeUtil(shape).bounds(shape)
	}

	/**
	 * Get the local bounds of a shape by its id.
	 *
	 * @example
	 * ```ts
	 * editor.getBoundsById(myShape)
	 * ```
	 *
	 * @param id - The id of the shape to get the bounds for.
	 *
	 * @public
	 */
	getBoundsById(id: TLShapeId): Box2d | undefined {
		const shape = this.getShapeById(id)
		if (!shape) return undefined
		return this.getBounds(shape)
	}

	/**
	 * Get the page (or absolute) bounds of a shape.
	 *
	 * @example
	 * ```ts
	 * editor.getPageBounds(myShape)
	 * ```
	 *
	 * @param shape - The shape to get the bounds for.
	 *
	 * @public
	 */
	getPageBounds(shape: TLShape): Box2d | undefined {
		return this.getPageBoundsById(shape.id)
	}

	/**
	 * Get the page (or absolute) bounds of a shape by its id.
	 *
	 * @example
	 * ```ts
	 * editor.getPageBoundsById(myShape)
	 * ```
	 *
	 * @param id - The id of the shape to get the page bounds for.
	 *
	 * @public
	 */
	getPageBoundsById(id: TLShapeId): Box2d | undefined {
		return this._pageBoundsCache.get(id)
	}

	/**
	 * Get the page (or absolute) bounds of a shape, incorporating any masks. For example, if the
	 * shape were the child of a frame and was half way out of the frame, the bounds would be the half
	 * of the shape that was in the frame.
	 *
	 * @example
	 * ```ts
	 * editor.getMaskedPageBounds(myShape)
	 * ```
	 *
	 * @param shape - The shape to get the masked bounds for.
	 *
	 * @public
	 */
	getMaskedPageBounds(shape: TLShape): Box2d | undefined {
		return this.getMaskedPageBoundsById(shape.id)
	}

	/**
	 * Get the page (or absolute) bounds of a shape by its id, incorporating any masks. For example,
	 * if the shape were the child of a frame and was half way out of the frame, the bounds would be
	 * the half of the shape that was in the frame.
	 *
	 * @example
	 * ```ts
	 * editor.getMaskedPageBoundsById(myShape)
	 * ```
	 *
	 * @param id - The id of the shape to get the masked page bounds for.
	 *
	 * @public
	 */
	getMaskedPageBoundsById(id: TLShapeId): Box2d | undefined {
		const pageBounds = this._pageBoundsCache.get(id)
		if (!pageBounds) return
		const pageMask = this._pageMaskCache.get(id)
		if (pageMask) {
			const intersection = intersectPolygonPolygon(pageMask, pageBounds.corners)
			if (!intersection) return
			return Box2d.FromPoints(intersection)
		}
		return pageBounds
	}

	/**
	 * Get the local outline of a shape.
	 *
	 * @example
	 * ```ts
	 * editor.getOutline(myShape)
	 * ```
	 *
	 * @param shape - The shape to get the outline for.
	 *
	 * @public
	 */
	getOutline(shape: TLShape) {
		return this.getShapeUtil(shape).outline(shape)
	}

	/**
	 * Get the local outline of a shape.
	 *
	 * @example
	 * ```ts
	 * editor.getOutlineById(myShape)
	 * ```
	 *
	 * @param id - The shape id to get the outline for.
	 *
	 * @public
	 */
	getOutlineById(id: TLShapeId) {
		return this.getOutline(this.getShapeById(id)!)
	}

	/**
	 * Get the ancestors of a shape.
	 *
	 * @example
	 * ```ts
	 * const ancestors = editor.getAncestors(myShape)
	 * ```
	 *
	 * @param shape - The shape to get the ancestors for.
	 *
	 * @public
	 */
	getAncestors(shape: TLShape, acc: TLShape[] = []): TLShape[] {
		const parentId = shape.parentId
		if (isPageId(parentId)) {
			acc.reverse()
			return acc
		}

		const parent = this.store.get(parentId)
		if (!parent) return acc
		acc.push(parent)
		return this.getAncestors(parent, acc)
	}

	/**
	 * Get the ancestors of a shape by its id.
	 *
	 * @example
	 * ```ts
	 * const ancestors = editor.getAncestorsById(myShape)
	 * ```
	 *
	 * @param id - The id of the shape to get the ancestors for.
	 *
	 * @public
	 */
	getAncestorsById(id: TLShapeId, acc: TLShape[] = []): TLShape[] {
		const shape = this.getShapeById(id)
		if (!shape) return acc
		return this.getAncestors(shape, acc)
	}

	/**
	 * Find the first ancestor matching the given predicate
	 *
	 * @example
	 * ```ts
	 * const ancestor = editor.findAncestor(myShape)
	 * ```
	 *
	 * @param shape - The shape to check the ancestors for.
	 *
	 * @public
	 */
	findAncestor(shape: TLShape, predicate: (parent: TLShape) => boolean): TLShape | undefined {
		const parentId = shape.parentId

		if (isPageId(parentId)) {
			return undefined
		}

		const parent = this.getShapeById(parentId)

		if (parent) {
			if (predicate(parent)) {
				return parent
			}
			return this.findAncestor(parent, predicate)
		}

		return undefined
	}

	/**
	 * Returns true if the the given shape has the given ancestor.
	 *
	 * @param shape - The shape.
	 * @param ancestorId - The id of the ancestor.
	 *
	 * @public
	 */
	hasAncestor(shape: TLShape | undefined, ancestorId: TLShapeId): boolean {
		if (!shape) return false
		if (shape.parentId === ancestorId) return true
		return this.hasAncestor(this.getParentShape(shape), ancestorId)
	}

	/**
	 * Get the common ancestor of two or more shapes that matches a predicate.
	 *
	 * @param shapes - The shapes to check.
	 * @param predicate - The predicate to match.
	 */
	findCommonAncestor(
		shapes: TLShape[],
		predicate?: (shape: TLShape) => boolean
	): TLShapeId | undefined {
		if (shapes.length === 0) {
			return
		}
		if (shapes.length === 1) {
			const parentId = shapes[0].parentId
			if (isPageId(parentId)) {
				return
			}
			return predicate ? this.findAncestor(shapes[0], predicate)?.id : parentId
		}

		const [nodeA, ...others] = shapes
		let ancestor = this.getParentShape(nodeA)
		while (ancestor) {
			// TODO: this is not ideal, optimize
			if (predicate && !predicate(ancestor)) {
				ancestor = this.getParentShape(ancestor)
				continue
			}
			if (others.every((shape) => this.hasAncestor(shape, ancestor!.id))) {
				return ancestor!.id
			}
			ancestor = this.getParentShape(ancestor)
		}
		return undefined
	}

	/**
	 * Check whether a shape is within the bounds of the current viewport.
	 *
	 * @param id - The id of the shape to check.
	 *
	 * @public
	 */
	isShapeInViewport(id: TLShapeId) {
		const pageBounds = this.getPageBoundsById(id)
		if (!pageBounds) return false
		return this.viewportPageBounds.includes(pageBounds)
	}

	/**
	 * Check whether a shape or its parent is locked.
	 *
	 * @param id - The id of the shape to check.
	 *
	 * @public
	 */
	isShapeOrAncestorLocked(shape?: TLShape): boolean {
		if (shape === undefined) return false
		if (shape.isLocked) return true
		return this.isShapeOrAncestorLocked(this.getParentShape(shape))
	}

	private computeUnorderedRenderingShapes(
		ids: TLParentId[],
		{
			cullingBounds,
			cullingBoundsExpanded,
			erasingIdsSet,
			editingId,
		}: {
			cullingBounds?: Box2d
			cullingBoundsExpanded?: Box2d
			erasingIdsSet?: Set<TLShapeId>
			editingId?: TLShapeId | null
		} = {}
	) {
		// Here we get the shape as well as any of its children, as well as their
		// opacities. If the shape is being erased, and none of its ancestors are
		// being erased, then we reduce the opacity of the shape and all of its
		// ancestors; but we don't apply this effect more than once among a set
		// of descendants so that it does not compound.

		// This is designed to keep all the shapes in a single list which
		// allows the DOM nodes to be reused even when they become children
		// of other nodes.

		const renderingShapes: {
			id: TLShapeId
			index: number
			backgroundIndex: number
			opacity: number
			isCulled: boolean
			isInViewport: boolean
			maskedPageBounds: Box2d | undefined
		}[] = []

		let nextIndex = MAX_SHAPES_PER_PAGE
		let nextBackgroundIndex = 0

		const addShapeById = (id: TLParentId, parentOpacity: number, isAncestorErasing: boolean) => {
			if (PageRecordType.isId(id)) {
				for (const childId of this.getSortedChildIds(id)) {
					addShapeById(childId, parentOpacity, isAncestorErasing)
				}
				return
			}

			const shape = this.getShapeById(id)
			if (!shape) return

			let opacity = shape.opacity * parentOpacity
			let isShapeErasing = false

			if (!isAncestorErasing && erasingIdsSet?.has(id)) {
				isShapeErasing = true
				opacity *= 0.32
			}

			// If a child is outside of its parent's clipping bounds, then bounds will be undefined.
			const maskedPageBounds = this.getMaskedPageBoundsById(id)

			// Whether the shape is on screen. Use the "strict" viewport here.
			const isInViewport = maskedPageBounds
				? cullingBounds?.includes(maskedPageBounds) ?? true
				: false

			// Whether the shape should actually be culled / unmounted.
			// - Use the "expanded" culling viewport to include shapes that are just off-screen.
			// - Editing shapes should never be culled.
			const isCulled = maskedPageBounds
				? (editingId !== id && !cullingBoundsExpanded?.includes(maskedPageBounds)) ?? true
				: true

			renderingShapes.push({
				id,
				index: nextIndex,
				backgroundIndex: nextBackgroundIndex,
				opacity,
				isCulled,
				isInViewport,
				maskedPageBounds,
			})

			nextIndex += 1
			nextBackgroundIndex += 1

			const childIds = this.getSortedChildIds(id)
			if (!childIds.length) return

			let backgroundIndexToRestore = null
			if (this.getShapeUtil(shape).providesBackgroundForChildren(shape)) {
				backgroundIndexToRestore = nextBackgroundIndex
				nextBackgroundIndex = nextIndex
				nextIndex += MAX_SHAPES_PER_PAGE
			}

			for (const childId of childIds) {
				addShapeById(childId, opacity, isAncestorErasing || isShapeErasing)
			}

			if (backgroundIndexToRestore !== null) {
				nextBackgroundIndex = backgroundIndexToRestore
			}
		}

		for (const id of ids) {
			addShapeById(id, 1, false)
		}

		return renderingShapes
	}

	/**
	 * Get the shapes that should be displayed in the current viewport.
	 *
	 * @public
	 */
	@computed get renderingShapes() {
		const renderingShapes = this.computeUnorderedRenderingShapes([this.currentPageId], {
			cullingBounds: this.cullingBounds,
			cullingBoundsExpanded: this.cullingBoundsExpanded,
			erasingIdsSet: this.erasingIdsSet,
			editingId: this.editingId,
		})

		// Its IMPORTANT that the result be sorted by id AND include the index
		// that the shape should be displayed at. Steve, this is the past you
		// telling the present you not to change this.

		// We want to sort by id because moving elements about in the DOM will
		// cause the element to get removed by react as it moves the DOM node. This
		// causes <iframes/> to re-render which is hella annoying and a perf
		// drain. By always sorting by 'id' we keep the shapes always in the
		// same order; but we later use index to set the element's 'z-index'
		// to change the "rendered" position in z-space.
		return renderingShapes.sort(sortById)
	}

	/**
	 * The common bounds of all of the shapes on the page.
	 *
	 * @public
	 */
	@computed get allShapesCommonBounds(): Box2d | null {
		let commonBounds = null as Box2d | null

		this.shapeIds.forEach((shapeId) => {
			const bounds = this.getMaskedPageBoundsById(shapeId)
			if (bounds) {
				if (commonBounds) {
					commonBounds.expand(bounds)
				} else {
					commonBounds = bounds.clone()
				}
			}
		})

		return commonBounds
	}

	/**
	 * Get the corners of a shape in page space.
	 *
	 * @example
	 * ```ts
	 * const corners = editor.getPageCorners(myShape)
	 * ```
	 *
	 * @param shape - The shape to get the corners for.
	 *
	 * @public
	 */
	getPageCorners(shape: TLShape): Vec2d[] {
		const ancestors = this.getAncestors(shape)
		const corners = this.getBounds(shape).corners

		const transform = Matrix2d.Compose(
			...ancestors.flatMap((s) => [Matrix2d.Translate(s.x, s.y), Matrix2d.Rotate(s.rotation)]),
			Matrix2d.Translate(shape.x, shape.y),
			Matrix2d.Rotate(shape.rotation, 0, 0)
		)

		return Matrix2d.applyToPoints(transform, corners)
	}

	/**
	 * Test whether a point (in page space) will will a shape. This method takes into account masks,
	 * such as when a shape is the child of a frame and is partially clipped by the frame.
	 *
	 * @example
	 * ```ts
	 * editor.isPointInShape({ x: 100, y: 100 }, myShape)
	 * ```
	 *
	 * @param point - The page point to test.
	 * @param shape - The shape to test against.
	 *
	 * @public
	 */
	isPointInShape(point: VecLike, shape: TLShape): boolean {
		const util = this.getShapeUtil(shape)

		const pageMask = this._pageMaskCache.get(shape.id)

		if (pageMask) {
			const hit = pointInPolygon(point, pageMask)
			if (!hit) return false
		}

		return util.hitTestPoint(shape, this.getPointInShapeSpace(shape, point))
	}

	/**
	 * Get the shapes, if any, at a given page point.
	 *
	 * @example
	 * ```ts
	 * editor.getShapesAtPoint({ x: 100, y: 100 })
	 * ```
	 *
	 * @param point - The page point to test.
	 *
	 * @public
	 */
	getShapesAtPoint(point: VecLike): TLShape[] {
		return this.shapesArray.filter((shape) => {
			// Check the page mask too
			const pageMask = this._pageMaskCache.get(shape.id)
			if (pageMask) {
				return pointInPolygon(point, pageMask)
			}

			// Otherwise, use the shape's own hit test method
			return this.getShapeUtil(shape).hitTestPoint(shape, this.getPointInShapeSpace(shape, point))
		})
	}

	/**
	 * Convert a point in page space to a point in the local space of a shape. For example, if a
	 * shape's page point were `{ x: 100, y: 100 }`, a page point at `{ x: 110, y: 110 }` would be at
	 * `{ x: 10, y: 10 }` in the shape's local space.
	 *
	 * @example
	 * ```ts
	 * editor.getPointInShapeSpace(myShape, { x: 100, y: 100 })
	 * ```
	 *
	 * @param shape - The shape to get the point in the local space of.
	 * @param point - The page point to get in the local space of the shape.
	 *
	 * @public
	 */
	getPointInShapeSpace(shape: TLShape, point: VecLike): Vec2d {
		return Matrix2d.applyToPoint(Matrix2d.Inverse(this.getPageTransform(shape)!), point)
	}

	/**
	 * Convert a delta in page space to a point in the local space of a shape. For example, if a
	 * shape's page point were `{ x: 100, y: 100 }`, a page point at `{ x: 110, y: 110 }` would be at
	 * `{ x: 10, y: 10 }` in the shape's local space.
	 *
	 * @example
	 * ```ts
	 * editor.getPointInShapeSpace(myShape.id, { x: 100, y: 100 })
	 * ```
	 *
	 * @param shape - The shape to get the point in the local space of.
	 * @param point - The page point to get in the local space of the shape.
	 *
	 * @public
	 */
	getPointInParentSpace(shapeId: TLShapeId, point: VecLike): Vec2d {
		const shape = this.getShapeById(shapeId)!
		if (!shape) {
			return new Vec2d(0, 0)
		}
		if (isPageId(shape.parentId)) return Vec2d.From(point)

		const parentTransform = this.getPageTransformById(shape.parentId)
		if (!parentTransform) return Vec2d.From(point)

		return Matrix2d.applyToPoint(Matrix2d.Inverse(parentTransform), point)
	}

	/**
	 * Convert a delta in page space to a delta in the local space of a shape.
	 *
	 * @example
	 * ```ts
	 * editor.getDeltaInShapeSpace(myShape, { x: 100, y: 100 })
	 * ```
	 *
	 * @param shape - The shape to get the delta in the local space of.
	 * @param delta - The page delta to convert.
	 *
	 * @public
	 */
	getDeltaInShapeSpace(shape: TLShape, delta: VecLike): Vec2d {
		const pageTransform = this.getPageTransform(shape)
		if (!pageTransform) return Vec2d.From(delta)
		return Vec2d.Rot(delta, -Matrix2d.Decompose(pageTransform).rotation)
	}

	/**
	 * Convert a delta in page space to a delta in the parent space of a shape.
	 *
	 * @example
	 * ```ts
	 * editor.getDeltaInParentSpace(myShape, { x: 100, y: 100 })
	 * ```
	 *
	 * @param shape - The shape to get the delta in the parent space of.
	 * @param delta - The page delta to convert.
	 *
	 * @public
	 */
	getDeltaInParentSpace(shape: TLShape, delta: VecLike): Vec2d {
		if (isPageId(shape.parentId)) return Vec2d.From(delta)

		const parent = this.getShapeById(shape.parentId)
		if (!parent) return Vec2d.From(delta)

		return this.getDeltaInShapeSpace(parent, delta)
	}

	/**
	 * For a given set of ids, get a map containing the ids of their parents and the children of those
	 * parents.
	 *
	 * @example
	 * ```ts
	 * editor.getParentsMappedToChildren(['id1', 'id2', 'id3'])
	 * ```
	 *
	 * @param ids - The ids to get the parents and children of.
	 *
	 * @public
	 */
	getParentsMappedToChildren(ids: TLShapeId[]) {
		const shapes = ids.map((id) => this.store.get(id)!)
		const parents = new Map<TLParentId, Set<TLShape>>()
		shapes.forEach((shape) => {
			if (!parents.has(shape.parentId)) {
				parents.set(shape.parentId, new Set())
			}
			parents.get(shape.parentId)?.add(shape)
		})
		return parents
	}

	/* -------------------- Viewport -------------------- */

	/**
	 * Update the viewport. The viewport will measure the size and screen position of its container
	 * element. This should be done whenever the container's position on the screen changes.
	 *
	 * @example
	 * ```ts
	 * editor.updateViewportScreenBounds()
	 * editor.updateViewportScreenBounds(true)
	 * ```
	 *
	 * @param center - (optional) Whether to preserve the viewport page center as the viewport changes.
	 *
	 * @public
	 */
	updateViewportScreenBounds(center = false) {
		const container = this.getContainer()

		if (!container) return this
		const rect = container.getBoundingClientRect()
		const screenBounds = new Box2d(0, 0, Math.max(rect.width, 1), Math.max(rect.height, 1))

		const boundsAreEqual = screenBounds.equals(this.viewportScreenBounds)

		// Get the current value
		const { _willSetInitialBounds } = this

		if (boundsAreEqual) {
			this._willSetInitialBounds = false
		} else {
			if (_willSetInitialBounds) {
				// If we have just received the initial bounds, don't center the camera.
				this._willSetInitialBounds = false
				this.updateInstanceState({ screenBounds: screenBounds.toJson() }, true, true)
			} else {
				const { zoomLevel } = this
				if (center) {
					const before = this.viewportPageCenter
					this.updateInstanceState({ screenBounds: screenBounds.toJson() }, true, true)
					const after = this.viewportPageCenter
					if (!this.instanceState.followingUserId) {
						this.pan((after.x - before.x) * zoomLevel, (after.y - before.y) * zoomLevel)
					}
				} else {
					const before = this.screenToPage(0, 0)
					this.updateInstanceState({ screenBounds: screenBounds.toJson() }, true, true)
					const after = this.screenToPage(0, 0)
					if (!this.instanceState.followingUserId) {
						this.pan((after.x - before.x) * zoomLevel, (after.y - before.y) * zoomLevel)
					}
				}
			}
		}

		this._cameraManager.tick()
		this.updateCullingBounds()

		const { editingId } = this

		if (editingId) {
			this.panZoomIntoView([editingId])
		}

		return this
	}

	/**
	 * The bounds of the editor's viewport in screen space.
	 *
	 * @public
	 */
	@computed get viewportScreenBounds() {
		const { x, y, w, h } = this.instanceState.screenBounds
		return new Box2d(x, y, w, h)
	}

	/**
	 * The center of the editor's viewport in screen space.
	 *
	 * @public
	 */
	@computed get viewportScreenCenter() {
		return this.viewportScreenBounds.center
	}

	/**
	 * The current viewport in page space.
	 *
	 * @public
	 */
	@computed get viewportPageBounds() {
		const { x, y, w, h } = this.viewportScreenBounds
		const tl = this.screenToPage(x, y)
		const br = this.screenToPage(x + w, y + h)
		return new Box2d(tl.x, tl.y, br.x - tl.x, br.y - tl.y)
	}

	/**
	 * The current culling bounds in page space, used for checking which shapes are "on screen".
	 *
	 * @public
	 */
	@computed get cullingBounds() {
		return this._cullingBounds.value
	}

	/** @internal */
	readonly _cullingBounds = atom('culling viewport', new Box2d())

	/**
	 * The current culling bounds in page space, expanded slightly. Used for determining which shapes
	 * to render and which to "cull".
	 *
	 * @public
	 */
	@computed get cullingBoundsExpanded() {
		return this._cullingBoundsExpanded.value
	}

	/** @internal */
	readonly _cullingBoundsExpanded = atom('culling viewport expanded', new Box2d())

	/**
	 * Update the culling bounds. This should be called when the viewport has stopped changing, such
	 * as at the end of a pan, zoom, or animation.
	 *
	 * @example
	 * ```ts
	 * editor.updateCullingBounds()
	 * ```
	 *
	 *
	 * @internal
	 */
	updateCullingBounds(): this {
		const { viewportPageBounds } = this
		if (viewportPageBounds.equals(this._cullingBounds.__unsafe__getWithoutCapture())) return this
		this._cullingBounds.set(viewportPageBounds.clone())
		this._cullingBoundsExpanded.set(viewportPageBounds.clone().expandBy(100 / this.zoomLevel))
		return this
	}

	/**
	 * The center of the viewport in page space.
	 *
	 * @public
	 */
	@computed get viewportPageCenter() {
		return this.viewportPageBounds.center
	}

	/**
	 * Convert a point in screen space to a point in page space.
	 *
	 * @example
	 * ```ts
	 * editor.screenToPage(100, 100)
	 * ```
	 *
	 * @param x - The x coordinate of the point in screen space.
	 * @param y - The y coordinate of the point in screen space.
	 * @param camera - The camera to use. Defaults to the current camera.
	 *
	 * @public
	 */
	screenToPage(x: number, y: number, z = 0.5, camera: Vec2dModel = this.camera) {
		const { screenBounds } = this.store.unsafeGetWithoutCapture(TLINSTANCE_ID)!
		const { x: cx, y: cy, z: cz = 1 } = camera
		return {
			x: (x - screenBounds.x) / cz - cx,
			y: (y - screenBounds.y) / cz - cy,
			z,
		}
	}

	/**
	 * Convert a point in page space to a point in screen space.
	 *
	 * @example
	 * ```ts
	 * editor.pageToScreen(100, 100)
	 * ```
	 *
	 * @param x - The x coordinate of the point in screen space.
	 * @param y - The y coordinate of the point in screen space.
	 * @param camera - The camera to use. Defaults to the current camera.
	 *
	 * @public
	 */
	pageToScreen(x: number, y: number, z = 0.5, camera: Vec2dModel = this.camera) {
		const { x: cx, y: cy, z: cz = 1 } = camera
		return {
			x: x + cx * cz,
			y: y + cy * cz,
			z,
		}
	}

	/* Focus Layers */

	/**
	 * The shape id of the current focus layer.
	 *
	 * @public
	 */
	get focusLayerId() {
		return this.pageState.focusLayerId ?? this.currentPageId
	}

	/**
	 * The shape of the current focus layer.
	 *
	 * @public
	 */
	get focusLayerShape(): TLShape | undefined {
		const id = this.pageState.focusLayerId
		if (!id) {
			return
		}
		return this.getShapeById(id)
	}

	/**
	 * Exit the current focus layer, moving up to the next group if there is one.
	 *
	 * @public
	 */
	popFocusLayer() {
		const current = this.pageState.focusLayerId
		const focusedShape = current && this.getShapeById(current)

		if (focusedShape) {
			// If we have a focused layer, look for an ancestor of the focused shape that is a group
			const match = this.findAncestor(focusedShape, (s) => s.type === 'group')
			// If we have an ancestor that can become a focused layer, set it as the focused layer
			this.setFocusLayer(match?.id ?? null)
			this.select(focusedShape.id)
		} else {
			// If there's no focused shape, then clear the focus layer and clear selection
			this.setFocusLayer(null)
			this.selectNone()
		}

		return this
	}

	/**
	 * Set the focus layer to the given shape id.
	 *
	 * @param next - The next focus layer id or null to reset the focus layer to the page
	 *
	 * @public
	 */
	setFocusLayer(next: null | TLShapeId) {
		this._setFocusLayer(next)
		return this
	}

	/** @internal */
	private _setFocusLayer = this.history.createCommand(
		'setFocusLayer',
		(next: null | TLShapeId) => {
			// When we first click an empty canvas we don't want this to show up in the undo stack
			if (next === null && !this.canUndo) {
				return
			}
			const prev = this.pageState.focusLayerId
			return { data: { prev, next }, preservesRedoStack: true, squashing: true }
		},
		{
			do: ({ next }) => {
				this.store.update(this.pageState.id, (s) => ({ ...s, focusLayerId: next }))
			},
			undo: ({ prev }) => {
				this.store.update(this.pageState.id, (s) => ({ ...s, focusLayerId: prev }))
			},
			squash({ prev }, { next }) {
				return { prev, next }
			},
		}
	)

	/**
	 * Set the hinted shape ids.
	 *
	 * @param ids - The ids to set as hinted.
	 *
	 * @public
	 */
	setHintingIds(ids: TLShapeId[]): this {
		// always ephemeral
		this.store.update(this.pageState.id, (s) => ({ ...s, hintingIds: dedupe(ids) }))
		return this
	}

	/**
	 * The current editing shape's id.
	 *
	 * @public
	 */
	get editingId() {
		return this.pageState.editingId
	}

	/**
	 * The current cropping shape's id.
	 *
	 * @public
	 */
	get croppingId() {
		return this.pageState.croppingId
	}

	@computed get editingShape() {
		if (!this.editingId) return null
		return this.getShapeById(this.editingId) ?? null
	}

	/**
	 * Set the current editing id.
	 *
	 * @param id - The id of the shape to edit or null to clear the editing id.
	 *
	 * @public
	 */
	setEditingId(id: TLShapeId | null): this {
		if (!id) {
			this.setInstancePageState({ editingId: null })
		} else {
			if (id !== this.editingId) {
				const shape = this.getShapeById(id)!
				const util = this.getShapeUtil(shape)
				if (shape && util.canEdit(shape)) {
					this.setInstancePageState({ editingId: id, hoveredId: null }, false)
					const { viewportPageBounds } = this
					const localEditingBounds = util.getEditingBounds(shape)!
					const pageTransform = this.getPageTransformById(id)!
					const pageEditingBounds = Box2d.FromPoints(
						Matrix2d.applyToPoints(pageTransform, localEditingBounds.corners)
					)

					if (!viewportPageBounds.contains(pageEditingBounds)) {
						if (
							pageEditingBounds.width > viewportPageBounds.width ||
							pageEditingBounds.height > viewportPageBounds.height
						) {
							this.zoomToBounds(
								pageEditingBounds.minX,
								pageEditingBounds.minY,
								pageEditingBounds.width,
								pageEditingBounds.height
							)
						} else {
							this.centerOnPoint(pageEditingBounds.midX, pageEditingBounds.midY)
						}
					}
				}
			}
		}

		return this
	}

	/**
	 * Set the current cropping shape's id.
	 *
	 * @param id - The id of the shape to crop or null to clear the cropping id.
	 *
	 * @public
	 */
	setCroppingId(id: TLShapeId | null): this {
		if (id !== this.croppingId) {
			if (!id) {
				this.setInstancePageState({ croppingId: null })
				if (this.isInAny('select.crop', 'select.pointing_crop_handle', 'select.cropping')) {
					this.setSelectedTool('select.idle')
				}
			} else {
				const shape = this.getShapeById(id)!
				const util = this.getShapeUtil(shape)
				if (shape && util.canCrop(shape)) {
					this.setInstancePageState({ croppingId: id, hoveredId: null })
				}
			}
		}
		return this
	}

	/**
	 * Get the id of what should be the parent of a new shape at a given point. The parent can be a page or shape.
	 *
	 * @param point - The point to find the parent for.
	 * @param shapeType - The type of shape that will be created.
	 *
	 * @returns The id of the parent.
	 *
	 * @public
	 */
	getParentIdForNewShapeAtPoint(point: VecLike, shapeType: TLShape['type']) {
		const shapes = this.sortedShapesArray

		for (let i = shapes.length - 1; i >= 0; i--) {
			const shape = shapes[i]
			const util = this.getShapeUtil(shape)
			if (!util.canReceiveNewChildrenOfType(shape, shapeType)) continue
			const maskedPageBounds = this.getMaskedPageBoundsById(shape.id)
			if (
				maskedPageBounds &&
				maskedPageBounds.containsPoint(point) &&
				util.hitTestPoint(shape, this.getPointInShapeSpace(shape, point))
			) {
				return shape.id
			}
		}

		return this.focusLayerId
	}

	/**
	 * Get the shape that some shapes should be dropped on at a given point.
	 *
	 * @param point - The point to find the parent for.
	 * @param droppingShapes - The shapes that are being dropped.
	 *
	 * @returns The shape to drop on.
	 *
	 * @public
	 */
	getDroppingShape(point: VecLike, droppingShapes: TLShape[] = []) {
		const shapes = this.sortedShapesArray

		for (let i = shapes.length - 1; i >= 0; i--) {
			const shape = shapes[i]
			// don't allow dropping a shape on itself or one of it's children
			if (droppingShapes.find((s) => s.id === shape.id || this.hasAncestor(shape, s.id))) continue
			const util = this.getShapeUtil(shape)
			if (!util.canDropShapes(shape, droppingShapes)) continue
			const maskedPageBounds = this.getMaskedPageBoundsById(shape.id)
			if (
				maskedPageBounds &&
				maskedPageBounds.containsPoint(point) &&
				util.hitTestPoint(shape, this.getPointInShapeSpace(shape, point))
			) {
				return shape
			}
		}

		return undefined
	}

	/**
	 * Get the shape that should be selected when you click on a given shape, assuming there is
	 * nothing already selected. It will not return anything higher than or including the current
	 * focus layer.
	 *
	 * @param shape - The shape to get the outermost selectable shape for.
	 * @param filter - A function to filter the selectable shapes.
	 *
	 * @returns The outermost selectable shape.
	 *
	 * @public
	 */
	getOutermostSelectableShape(shape: TLShape, filter?: (shape: TLShape) => boolean): TLShape {
		let match = shape
		let node = shape as TLShape | undefined
		while (node) {
			if (
				node.type === 'group' &&
				this.focusLayerId !== node.id &&
				!this.hasAncestor(this.focusLayerShape, node.id) &&
				(filter?.(node) ?? true)
			) {
				match = node
			} else if (this.focusLayerId === node.id) {
				break
			}
			node = this.getParentShape(node)
		}

		return match
	}

	/* --------------------- Shapes --------------------- */

	/**
	 * The app's set of styles.
	 *
	 * @public
	 */
	static styles = STYLES

	/**
	 * The current page bounds of all the selected shapes (Not the same thing as the page bounds of the selection bounding box when the selection has been rotated)
	 *
	 * @readonly
	 *
	 * @public
	 */
	@computed get selectedPageBounds(): Box2d | null {
		const {
			pageState: { selectedIds },
		} = this

		if (selectedIds.length === 0) return null

		return Box2d.Common(compact(selectedIds.map((id) => this.getPageBoundsById(id))))
	}

	/**
	 * The rotation of the selection bounding box.
	 *
	 * @readonly
	 * @public
	 */
	@computed get selectionRotation(): number {
		const { selectedIds } = this
		if (selectedIds.length === 0) {
			return 0
		}
		if (selectedIds.length === 1) {
			return this.getPageRotationById(this.selectedIds[0])
		}

		const allRotations = selectedIds.map((id) => this.getPageRotationById(id) % (Math.PI / 2))
		// if the rotations are all compatible with each other, return the rotation of any one of them
		if (allRotations.every((rotation) => Math.abs(rotation - allRotations[0]) < Math.PI / 180)) {
			return this.getPageRotationById(selectedIds[0])
		}
		return 0
	}

	/**
	 * The bounds of the selection bounding box.
	 *
	 * @readonly
	 * @public
	 */
	@computed get selectionBounds(): Box2d | undefined {
		const { selectedIds } = this

		if (selectedIds.length === 0) {
			return undefined
		}

		const { selectionRotation } = this
		if (selectionRotation === 0) {
			return this.selectedPageBounds!
		}

		if (selectedIds.length === 1) {
			const bounds = this.getBounds(this.getShapeById(selectedIds[0])!).clone()
			bounds.point = Matrix2d.applyToPoint(this.getPageTransformById(selectedIds[0])!, bounds.point)
			return bounds
		}

		// need to 'un-rotate' all the outlines of the existing nodes so we can fit them inside a box
		const allPoints = this.selectedIds
			.flatMap((id) => {
				const pageTransform = this.getPageTransformById(id)
				if (!pageTransform) return []
				return this.getOutlineById(id).map((point) => Matrix2d.applyToPoint(pageTransform, point))
			})
			.map((p) => Vec2d.Rot(p, -selectionRotation))
		const box = Box2d.FromPoints(allPoints)
		// now position box so that it's top-left corner is in the right place
		box.point = box.point.rot(selectionRotation)
		return box
	}

	/**
	 * The center of the selection bounding box.
	 *
	 * @readonly
	 * @public
	 */
	@computed get selectionPageCenter() {
		const { selectionBounds, selectionRotation } = this
		if (!selectionBounds) return null
		return Vec2d.RotWith(selectionBounds.center, selectionBounds.point, selectionRotation)
	}

	/**
	 * An array containing all of the shapes in the current page.
	 *
	 * @example
	 * ```ts
	 * editor.shapesArray
	 * ```
	 *
	 * @readonly
	 *
	 * @public
	 */
	@computed get shapesArray() {
		return Array.from(this.shapeIds, (id) => this.store.get(id)! as TLShape)
	}

	/**
	 * An array containing all of the shapes in the current page, sorted in z-index order (accounting
	 * for nested shapes): e.g. A, B, BA, BB, C.
	 *
	 * @example
	 * ```ts
	 * editor.sortedShapesArray
	 * ```
	 *
	 * @readonly
	 *
	 * @public
	 */
	@computed get sortedShapesArray(): TLShape[] {
		const shapes = new Set(this.shapesArray.sort(sortByIndex))

		const results: TLShape[] = []

		function pushShapeWithDescendants(shape: TLShape): void {
			results.push(shape)
			shapes.delete(shape)

			shapes.forEach((otherShape) => {
				if (otherShape.parentId === shape.id) {
					pushShapeWithDescendants(otherShape)
				}
			})
		}

		shapes.forEach((shape) => {
			const parent = this.getShapeById(shape.parentId)
			if (!isShape(parent)) {
				pushShapeWithDescendants(shape)
			}
		})

		return results
	}

	/**
	 * An array containing all of the currently selected shapes.
	 *
	 * @example
	 * ```ts
	 * editor.selectedShapes
	 * ```
	 *
	 * @public
	 * @readonly
	 */
	@computed get selectedShapes(): TLShape[] {
		const { selectedIds } = this.pageState
		return compact(selectedIds.map((id) => this.store.get(id)))
	}

	/**
	 * The app's only selected shape.
	 *
	 * @example
	 * ```ts
	 * editor.onlySelectedShape
	 * ```
	 *
	 * @returns Null if there is no shape or more than one selected shape, otherwise the selected
	 *   shape.
	 *
	 * @public
	 * @readonly
	 */
	@computed get onlySelectedShape(): TLShape | null {
		const { selectedShapes } = this
		return selectedShapes.length === 1 ? selectedShapes[0] : null
	}

	/**
	 * Get whether a shape matches the type of a TLShapeUtil.
	 *
	 * @example
	 * ```ts
	 * const isArrowShape = isShapeOfType(someShape, ArrowShapeUtil)
	 * ```
	 *
	 * @param util - the TLShapeUtil constructor to test against
	 * @param shape - the shape to test
	 *
	 * @public
	 */
	isShapeOfType<T extends TLUnknownShape>(
		shape: TLUnknownShape,
		util: { new (...args: any): ShapeUtil<T>; type: string }
	): shape is T {
		return shape.type === util.type
	}

	/**
	 * Get a shape by its id.
	 *
	 * @example
	 * ```ts
	 * editor.getShapeById('box1')
	 * ```
	 *
	 * @param id - The id of the shape to get.
	 *
	 * @public
	 */
	getShapeById<T extends TLShape = TLShape>(id: TLParentId): T | undefined {
		if (!isShapeId(id)) return undefined
		return this.store.get(id) as T
	}

	/**
	 * Get the parent shape for a given shape. Returns undefined if the shape is the direct child of
	 * the page.
	 *
	 * @example
	 * ```ts
	 * editor.getParentShape(myShape)
	 * ```
	 *
	 * @public
	 */
	getParentShape(shape?: TLShape): TLShape | undefined {
		if (shape === undefined || !isShapeId(shape.parentId)) return undefined
		return this.store.get(shape.parentId)
	}

	/**
	 * If siblingShape and targetShape are siblings, this returns targetShape. If targetShape has an
	 * ancestor who is a sibling of siblingShape, this returns that ancestor. Otherwise, this returns
	 * undefined.
	 *
	 * @internal
	 */
	private getNearestSiblingShape(
		siblingShape: TLShape,
		targetShape: TLShape | undefined
	): TLShape | undefined {
		if (!targetShape) {
			return undefined
		}
		if (targetShape.parentId === siblingShape.parentId) {
			return targetShape
		}

		const ancestor = this.findAncestor(
			targetShape,
			(ancestor) => ancestor.parentId === siblingShape.parentId
		)

		return ancestor
	}

	/**
	 * Get the id of the containing page for a given shape.
	 *
	 * @param shape - The shape to get the page id for.
	 *
	 * @returns The id of the page that contains the shape, or undefined if the shape is undefined.
	 *
	 * @public
	 */
	getParentPageId(shape?: TLShape): TLPageId | undefined {
		if (shape === undefined) return undefined
		if (isPageId(shape.parentId)) {
			return shape.parentId
		} else {
			return this.getParentPageId(this.getShapeById(shape.parentId))
		}
	}

	/**
	 * Get whether the given shape is the descendant of the given page.
	 *
	 * @example
	 * ```ts
	 * editor.isShapeInPage(myShape)
	 * editor.isShapeInPage(myShape, 'page1')
	 * ```
	 *
	 * @param shape - The shape to check.
	 * @param pageId - The id of the page to check against. Defaults to the current page.
	 *
	 * @public
	 */
	isShapeInPage(shape: TLShape, pageId = this.currentPageId): boolean {
		let shapeIsInPage = false

		if (shape.parentId === pageId) {
			shapeIsInPage = true
		} else {
			let parent = this.getShapeById(shape.parentId)
			isInPageSearch: while (parent) {
				if (parent.parentId === pageId) {
					shapeIsInPage = true
					break isInPageSearch
				}
				parent = this.getShapeById(parent.parentId)
			}
		}

		return shapeIsInPage
	}

	/* --------------------- Styles --------------------- */

	/**
	 * A mapping of color ids to CSS color values.
	 *
	 * @internal
	 */
	private colors: Map<TLColorStyle['id'], string>

	/**
	 * A mapping of size ids to size values.
	 *
	 * @internal
	 */
	private sizes = {
		s: 2,
		m: 3.5,
		l: 5,
		xl: 10,
	}

	/**
	 * Get the CSS color value for a given color id.
	 *
	 * @example
	 * ```ts
	 * editor.getCssColor('red')
	 * ```
	 *
	 * @param id - The id of the color to get.
	 *
	 * @public
	 */
	getCssColor(id: TLColorStyle['id']): string {
		return this.colors.get(id)!
	}

	/**
	 * Get the stroke width value for a given size id.
	 *
	 * @example
	 * ```ts
	 * editor.getStrokeWidth('m')
	 * ```
	 *
	 * @param id - The id of the size to get.
	 *
	 * @public
	 */
	getStrokeWidth(id: TLSizeStyle['id']): number {
		return this.sizes[id]
	}

	/* ------------------- Statechart ------------------- */

	/**
	 * The id of the current selected tool.
	 *
	 * @public
	 */
	get currentToolId(): string {
		const activeTool = this.root.current.value
		let activeToolId = activeTool?.id

		// Often a tool will transition into one of the following select states after the initial pointerdown: 'translating', 'resizing', 'dragging_handle'
		// It should then supply the tool id to the `onInteractionEnd` property to tell us which tool initially triggered the interaction.
		// If tool lock mode is on then tldraw will switch to the given tool id.
		// If tool lock mode is off then tldraw will switch back to the select tool when the interaction ends.

		if (activeToolId === 'select' || activeToolId === 'zoom') {
			const currentChildState = activeTool?.current.value as any
			activeToolId = currentChildState?.info?.onInteractionEnd ?? 'select'
		}

		return activeToolId ?? 'select'
	}

	/**
	 * Set the selected tool.
	 *
	 * @example
	 * ```ts
	 * editor.setSelectedTool('hand')
	 * editor.setSelectedTool('hand', { date: Date.now() })
	 * ```
	 *
	 * @param id - The id of the tool to select.
	 * @param info - Arbitrary data to pass along into the transition.
	 *
	 * @public
	 */
	setSelectedTool(id: string, info = {}) {
		this.root.transition(id, info)
		return this
	}

	/**
	 * Get a descendant by its path.
	 *
	 * @example
	 * ```ts
	 * state.getStateDescendant('select')
	 * state.getStateDescendant('select.brushing')
	 * ```
	 *
	 * @param path - The descendant's path of state ids, separated by periods.
	 *
	 * @public
	 */
	getStateDescendant(path: string): StateNode | undefined {
		const ids = path.split('.').reverse()
		let state = this.root as StateNode
		while (ids.length > 0) {
			const id = ids.pop()
			if (!id) return state
			const childState = state.children?.[id]
			if (!childState) return undefined
			state = childState
		}
		return state
	}

	/**
	 * Get whether a certain tool (or other state node) is currently active.
	 *
	 * @example
	 * ```ts
	 * editor.isIn('select')
	 * editor.isIn('select.brushing')
	 * ```
	 *
	 * @param path - The path of active states, separated by periods.
	 *
	 * @public
	 */
	isIn(path: string): boolean {
		const ids = path.split('.').reverse()
		let state = this.root as StateNode
		while (ids.length > 0) {
			const id = ids.pop()
			if (!id) return true
			const current = state.current.value
			if (current?.id === id) {
				if (ids.length === 0) return true
				state = current
				continue
			} else return false
		}
		return false
	}

	/**
	 * Get whether the state node is in any of the given active paths.
	 *
	 * @example
	 * ```ts
	 * state.isInAny('select', 'erase')
	 * state.isInAny('select.brushing', 'erase.idle')
	 * ```
	 *
	 * @public
	 */
	isInAny(...paths: string[]): boolean {
		return paths.some((path) => this.isIn(path))
	}

	/* --------------------- Inputs --------------------- */

	/**
	 * The app's current input state.
	 *
	 * @public
	 */
	inputs = {
		/** The most recent pointer down's position in page space. */
		originPagePoint: new Vec2d(),
		/** The most recent pointer down's position in screen space. */
		originScreenPoint: new Vec2d(),
		/** The previous pointer position in page space. */
		previousPagePoint: new Vec2d(),
		/** The previous pointer position in screen space. */
		previousScreenPoint: new Vec2d(),
		/** The most recent pointer position in page space. */
		currentPagePoint: new Vec2d(),
		/** The most recent pointer position in screen space. */
		currentScreenPoint: new Vec2d(),
		/** A set containing the currently pressed keys. */
		keys: new Set<string>(),
		/** A set containing the currently pressed buttons. */
		buttons: new Set<number>(),
		/** Whether the input is from a pe. */
		isPen: false,
		/** Whether the shift key is currently pressed. */
		shiftKey: false,
		/** Whether the control or command key is currently pressed. */
		ctrlKey: false,
		/** Whether the alt or option key is currently pressed. */
		altKey: false,
		/** Whether the user is dragging. */
		isDragging: false,
		/** Whether the user is pointing. */
		isPointing: false,
		/** Whether the user is pinching. */
		isPinching: false,
		/** Whether the user is editing. */
		isEditing: false,
		/** Whether the user is panning. */
		isPanning: false,
		/** Velocity of mouse pointer, in pixels per millisecond */
		pointerVelocity: new Vec2d(),
	}

	/**
	 * Update the input points from a pointer or pinch event.
	 *
	 * @param info - The event info.
	 */
	private _updateInputsFromEvent(info: TLPointerEventInfo | TLPinchEventInfo) {
		const { previousScreenPoint, previousPagePoint, currentScreenPoint, currentPagePoint } =
			this.inputs

		const { screenBounds } = this.store.unsafeGetWithoutCapture(TLINSTANCE_ID)!
		const { x: sx, y: sy, z: sz } = info.point
		const { x: cx, y: cy, z: cz } = this.camera

		previousScreenPoint.setTo(currentScreenPoint)
		previousPagePoint.setTo(currentPagePoint)

		const px = (sx - screenBounds.x) / cz - cx
		const py = (sy - screenBounds.y) / cz - cy

		currentScreenPoint.set(sx, sy)
		currentPagePoint.set(px, py, sz ?? 0.5)

		this.inputs.isPen = info.type === 'pointer' && info.isPen

		// Reset velocity on pointer down
		if (info.name === 'pointer_down') {
			this.inputs.pointerVelocity = new Vec2d()
		}

		// todo: We only have to do this if there are multiple users in the document
		this.store.put([
			{
				id: TLPOINTER_ID,
				typeName: 'pointer',
				x: currentPagePoint.x,
				y: currentPagePoint.y,
				lastActivityTimestamp: Date.now(),
			},
		])
	}

	/* --------------------- Events --------------------- */

	/**
	 * A manager for recording multiple click events.
	 *
	 * @internal
	 */
	protected _clickManager = new ClickManager(this)

	/**
	 * Prevent a double click event from firing the next time the user clicks
	 *
	 * @public
	 */
	cancelDoubleClick() {
		this._clickManager.cancelDoubleClickTimeout()
	}

	/**
	 * The previous cursor. Used for restoring the cursor after pan events.
	 *
	 * @internal
	 */
	private _prevCursor: TLCursorType = 'default'

	/** @internal */
	private _shiftKeyTimeout = -1 as any

	/** @internal */
	private _setShiftKeyTimeout = () => {
		this.inputs.shiftKey = false
		this.dispatch({
			type: 'keyboard',
			name: 'key_up',
			key: 'Shift',
			shiftKey: this.inputs.shiftKey,
			ctrlKey: this.inputs.ctrlKey,
			altKey: this.inputs.altKey,
			code: 'ShiftLeft',
		})
	}

	/** @internal */
	private _altKeyTimeout = -1 as any

	/** @internal */
	private _setAltKeyTimeout = () => {
		this.inputs.altKey = false
		this.dispatch({
			type: 'keyboard',
			name: 'key_up',
			key: 'Alt',
			shiftKey: this.inputs.shiftKey,
			ctrlKey: this.inputs.ctrlKey,
			altKey: this.inputs.altKey,
			code: 'AltLeft',
		})
	}

	/** @internal */
	private _ctrlKeyTimeout = -1 as any

	/** @internal */
	private _setCtrlKeyTimeout = () => {
		this.inputs.ctrlKey = false
		this.dispatch({
			type: 'keyboard',
			name: 'key_up',
			key: 'Ctrl',
			shiftKey: this.inputs.shiftKey,
			ctrlKey: this.inputs.ctrlKey,
			altKey: this.inputs.altKey,
			code: 'ControlLeft',
		})
	}

	/** @internal */
	private _restoreToolId = 'select'

	/** @internal */
	private _pinchStart = 1

	/** @internal */
	private _didPinch = false

	/** @internal */
	private _selectedIdsAtPointerDown: TLShapeId[] = []

	/** @internal */
	capturedPointerId: number | null = null

	/**
	 * Dispatch an event to the editor.
	 *
	 * @example
	 * ```ts
	 * editor.dispatch(myPointerEvent)
	 * ```
	 *
	 * @param info - The event info.
	 *
	 * @public
	 */
	dispatch(info: TLEventInfo): this {
		// prevent us from spamming similar event errors if we're crashed.
		// todo: replace with new readonly mode?
		if (this.crashingError) return this

		const { inputs } = this
		const { type } = info

		this.batch(() => {
			if (info.type === 'misc') {
				// stop panning if the interaction is cancelled or completed
				if (info.name === 'cancel' || info.name === 'complete') {
					this.inputs.isDragging = false

					if (this.inputs.isPanning) {
						this.inputs.isPanning = false
						this.setCursor({
							type: this._prevCursor,
						})
					}
				}

				this.root.handleEvent(info)
				return
			}

			if (info.shiftKey) {
				clearInterval(this._shiftKeyTimeout)
				this._shiftKeyTimeout = -1
				inputs.shiftKey = true
			} else if (!info.shiftKey && inputs.shiftKey && this._shiftKeyTimeout === -1) {
				this._shiftKeyTimeout = setTimeout(this._setShiftKeyTimeout, 150)
			}

			if (info.altKey) {
				clearInterval(this._altKeyTimeout)
				this._altKeyTimeout = -1
				inputs.altKey = true
			} else if (!info.altKey && inputs.altKey && this._altKeyTimeout === -1) {
				this._altKeyTimeout = setTimeout(this._setAltKeyTimeout, 150)
			}

			if (info.ctrlKey) {
				clearInterval(this._ctrlKeyTimeout)
				this._ctrlKeyTimeout = -1
				inputs.ctrlKey = true /** @internal */ /** @internal */ /** @internal */
			} else if (!info.ctrlKey && inputs.ctrlKey && this._ctrlKeyTimeout === -1) {
				this._ctrlKeyTimeout = setTimeout(this._setCtrlKeyTimeout, 150)
			}

			const { originPagePoint, originScreenPoint, currentPagePoint, currentScreenPoint } = inputs

			if (!inputs.isPointing) {
				inputs.isDragging = false
			}

			switch (type) {
				case 'pinch': {
					if (!this.canMoveCamera) return
					this._updateInputsFromEvent(info)

					switch (info.name) {
						case 'pinch_start': {
							if (inputs.isPinching) return

							if (!inputs.isEditing) {
								this._pinchStart = this.camera.z
								if (!this._selectedIdsAtPointerDown.length) {
									this._selectedIdsAtPointerDown = this.selectedIds.slice()
								}

								this._didPinch = true

								inputs.isPinching = true

								this.interrupt()
							}

							return // Stop here!
						}
						case 'pinch': {
							if (!inputs.isPinching) return

							const {
								point: { x, y, z = 1 },
								delta: { x: dx, y: dy },
							} = info

							const {
								camera: { x: cx, y: cy, z: cz },
							} = this

							const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z))

							this.setCamera(
								cx + dx / cz - x / cz + x / zoom,
								cy + dy / cz - y / cz + y / zoom,
								zoom
							)

							return // Stop here!
						}
						case 'pinch_end': {
							if (!inputs.isPinching) return this

							inputs.isPinching = false
							const { _selectedIdsAtPointerDown } = this
							this.setSelectedIds(this._selectedIdsAtPointerDown, true)
							this._selectedIdsAtPointerDown = []

							const {
								camera: { x: cx, y: cy, z: cz },
							} = this

							let zoom: number | undefined

							if (cz > 0.9 && cz < 1.05) {
								zoom = 1
							} else if (cz > 0.49 && cz < 0.505) {
								zoom = 0.5
							}

							if (cz > this._pinchStart - 0.1 && cz < this._pinchStart + 0.05) {
								zoom = this._pinchStart
							}

							if (zoom !== undefined) {
								const { x, y } = this.viewportScreenCenter
								this.animateCamera(
									cx + (x / zoom - x) - (x / cz - x),
									cy + (y / zoom - y) - (y / cz - y),
									zoom,
									{ duration: 100 }
								)
							}

							if (this._didPinch) {
								this._didPinch = false
								requestAnimationFrame(() => {
									if (!this._didPinch) {
										this.setSelectedIds(_selectedIdsAtPointerDown, true)
									}
								})
							}

							return // Stop here!
						}
					}
				}
				case 'wheel': {
					if (!this.canMoveCamera) return

					if (this.isMenuOpen) {
						// noop
					} else {
						if (inputs.ctrlKey) {
							// todo: Start or update the zoom end interval

							// If the alt or ctrl keys are pressed,
							// zoom or pan the camera and then return.
							const { x, y } = this.inputs.currentScreenPoint
							const { x: cx, y: cy, z: cz } = this.camera

							const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, cz + (info.delta.z ?? 0) * cz))

							this.setCamera(
								cx + (x / zoom - x) - (x / cz - x),
								cy + (y / zoom - y) - (y / cz - y),
								zoom
							)

							// We want to return here because none of the states in our
							// statechart should respond to this event (a camera zoom)
							return
						}

						// Update the camera here, which will dispatch a pointer move...
						// this will also update the pointer position, etc
						this.pan(info.delta.x, info.delta.y)

						if (
							!inputs.isDragging &&
							inputs.isPointing &&
							originPagePoint.dist(currentPagePoint) >
								(this.isCoarsePointer ? COARSE_DRAG_DISTANCE : DRAG_DISTANCE) / this.zoomLevel
						) {
							inputs.isDragging = true
						}
					}
					break
				}
				case 'pointer': {
					// If we're pinching, return
					if (inputs.isPinching) return

					this._updateInputsFromEvent(info)

					const { isPen } = info

					switch (info.name) {
						case 'pointer_down': {
							this._selectedIdsAtPointerDown = this.selectedIds.slice()

							// Firefox bug fix...
							// If it's a left-mouse-click, we store the pointer id for later user
							if (info.button === 0) {
								this.capturedPointerId = info.pointerId
							}

							// Add the button from the buttons set
							inputs.buttons.add(info.button)

							inputs.isPointing = true
							inputs.isDragging = false

							if (this.isPenMode) {
								if (!isPen) {
									// decrement the remaining taps before exiting pen mode
									this._touchEventsRemainingBeforeExitingPenMode--
									if (this._touchEventsRemainingBeforeExitingPenMode === 0) {
										this.setPenMode(false)
									} else {
										return
									}
								} else {
									// reset the remaining taps before exiting pen mode
									this._touchEventsRemainingBeforeExitingPenMode = 3
								}
							} else {
								if (isPen) {
									this.setPenMode(true)
								}
							}

							if (info.button === 5) {
								// Eraser button activates eraser
								this._restoreToolId = this.currentToolId
								this.complete()
								this.setSelectedTool('eraser')
							} else if (info.button === 1) {
								// Middle mouse pan activates panning
								if (!this.inputs.isPanning) {
									this._prevCursor = this.instanceState.cursor.type
								}

								this.inputs.isPanning = true
							}

							if (this.inputs.isPanning) {
								this.stopCameraAnimation()
								this.setCursor({
									type: 'grabbing',
								})
								return this
							}

							originScreenPoint.setTo(currentScreenPoint)
							originPagePoint.setTo(currentPagePoint)
							break
						}
						case 'pointer_move': {
							// If the user is in pen mode, but the pointer is not a pen, stop here.
							if (!isPen && this.isPenMode) {
								return
							}

							if (this.inputs.isPanning && this.inputs.isPointing) {
								// Handle panning
								const { currentScreenPoint, previousScreenPoint } = this.inputs
								const delta = Vec2d.Sub(currentScreenPoint, previousScreenPoint)
								this.pan(delta.x, delta.y)
								return
							}

							if (
								!inputs.isDragging &&
								inputs.isPointing &&
								originPagePoint.dist(currentPagePoint) >
									(this.isCoarsePointer ? COARSE_DRAG_DISTANCE : DRAG_DISTANCE) / this.zoomLevel
							) {
								inputs.isDragging = true
							}
							break
						}
						case 'pointer_up': {
							// Remove the button from the buttons set
							inputs.buttons.delete(info.button)

							inputs.isPointing = false
							inputs.isDragging = false

							if (this.isMenuOpen) {
								// Suppressing pointerup here as <ContextMenu/> doesn't seem to do what we what here.
								return
							}

							if (!isPen && this.isPenMode) {
								return
							}

							// Firefox bug fix...
							// If it's the same pointer that we stored earlier...
							// ... then it's probably still a left-mouse-click!
							if (this.capturedPointerId === info.pointerId) {
								this.capturedPointerId = null
								info.button = 0
							}

							if (inputs.isPanning) {
								if (info.button === 1) {
									if (!this.inputs.keys.has(' ')) {
										inputs.isPanning = false

										this.slideCamera({
											speed: Math.min(2, this.inputs.pointerVelocity.len()),
											direction: this.inputs.pointerVelocity,
											friction: HAND_TOOL_FRICTION,
										})
										this.setCursor({
											type: this._prevCursor,
										})
									} else {
										this.slideCamera({
											speed: Math.min(2, this.inputs.pointerVelocity.len()),
											direction: this.inputs.pointerVelocity,
											friction: HAND_TOOL_FRICTION,
										})
										this.setCursor({
											type: 'grab',
										})
									}
								} else if (info.button === 0) {
									this.slideCamera({
										speed: Math.min(2, this.inputs.pointerVelocity.len()),
										direction: this.inputs.pointerVelocity,
										friction: HAND_TOOL_FRICTION,
									})
									this.setCursor({
										type: 'grab',
									})
								}
							} else {
								if (info.button === 5) {
									// Eraser button activates eraser
									this.complete()
									this.setSelectedTool(this._restoreToolId)
								}
							}

							break
						}
					}

					break
				}
				case 'keyboard': {
					// please, please
					if (info.key === 'ShiftRight') info.key = 'ShiftLeft'
					if (info.key === 'AltRight') info.key = 'AltLeft'
					if (info.code === 'ControlRight') info.code = 'ControlLeft'

					switch (info.name) {
						case 'key_down': {
							// Add the key from the keys set
							inputs.keys.add(info.code)

							// If the space key is pressed (but meta / control isn't!) activate panning
							if (!info.ctrlKey && info.code === 'Space') {
								if (!this.inputs.isPanning) {
									this._prevCursor = this.instanceState.cursor.type
								}

								this.inputs.isPanning = true
								this.setCursor({
									type: this.inputs.isPointing ? 'grabbing' : 'grab',
								})
							}

							break
						}
						case 'key_up': {
							// Remove the key from the keys set
							inputs.keys.delete(info.code)

							if (info.code === 'Space' && !this.inputs.buttons.has(1)) {
								this.inputs.isPanning = false
								this.setCursor({
									type: this._prevCursor,
								})
							}

							break
						}
						case 'key_repeat': {
							// noop
							break
						}
					}
					break
				}
			}

			// Correct the info name for right / middle clicks
			if (info.type === 'pointer') {
				if (info.button === 1) {
					info.name = 'middle_click'
				} else if (info.button === 2) {
					info.name = 'right_click'
				}

				// If a pointer event, send the event to the click manager.
				if (info.isPen === this.isPenMode) {
					switch (info.name) {
						case 'pointer_down': {
							const otherEvent = this._clickManager.transformPointerDownEvent(info)
							if (info.name !== otherEvent.name) {
								this.root.handleEvent(info)
								this.emit('event', info)
								this.root.handleEvent(otherEvent)
								this.emit('event', otherEvent)
								return
							}

							break
						}
						case 'pointer_up': {
							const otherEvent = this._clickManager.transformPointerUpEvent(info)
							if (info.name !== otherEvent.name) {
								this.root.handleEvent(info)
								this.emit('event', info)
								this.root.handleEvent(otherEvent)
								this.emit('event', otherEvent)
								return
							}

							break
						}
						case 'pointer_move': {
							this._clickManager.handleMove()
							break
						}
					}
				}
			}

			// Send the event to the statechart. It will be handled by all
			// active states, starting at the root.
			this.root.handleEvent(info)
			this.emit('event', info)
		})

		return this
	}

	/**
	 * Replace the store's contents with the given records.
	 *
	 * @param records - The records to replace the store's contents with.
	 */
	replaceStoreContentsWithRecordsForOtherDocument(records: TLRecord[]) {
		transact(() => {
			this.store.clear()
			const [shapes, nonShapes] = partition(records, (record) => record.typeName === 'shape')
			this.store.put(nonShapes, 'initialize')
			this.store.ensureStoreIsUsable()
			this.store.put(shapes, 'initialize')
			this.history.clear()
			this.updateViewportScreenBounds()
			this.updateCullingBounds()

			const bounds = this.allShapesCommonBounds
			if (bounds) {
				this.zoomToBounds(bounds.minX, bounds.minY, bounds.width, bounds.height, 1)
			}
		})
	}

	/**
	 * Get content that can be exported for the given shape ids.
	 *
	 * @param ids - The ids of the shapes to get content for. Defaults to the selected shape ids.
	 *
	 * @returns The exported content.
	 *
	 * @public
	 */
	getContent(ids: TLShapeId[] = this.selectedIds): TLContent | undefined {
		if (!ids) return
		if (ids.length === 0) return

		const pageTransforms: Record<string, Matrix2dModel> = {}

		let shapes = dedupe(
			ids
				.map((id) => this.getShapeById(id)!)
				.sort(sortByIndex)
				.flatMap((shape) => {
					const allShapes = [shape]
					this.visitDescendants(shape.id, (descendant) => {
						allShapes.push(this.getShapeById(descendant)!)
					})
					return allShapes
				})
		)

		shapes = shapes.map((shape) => {
			pageTransforms[shape.id] = this.getPageTransformById(shape.id)!

			shape = structuredClone(shape) as typeof shape

			if (this.isShapeOfType(shape, ArrowShapeUtil)) {
				const startBindingId =
					shape.props.start.type === 'binding' ? shape.props.start.boundShapeId : undefined

				const endBindingId =
					shape.props.end.type === 'binding' ? shape.props.end.boundShapeId : undefined

				const info = this.getShapeUtil(ArrowShapeUtil).getArrowInfo(shape)

				if (shape.props.start.type === 'binding') {
					if (!shapes.some((s) => s.id === startBindingId)) {
						// Uh oh, the arrow's bound-to shape isn't among the shapes
						// that we're getting the content for. We should try to adjust
						// the arrow so that it appears in the place it would be
						if (info?.isValid) {
							const { x, y } = info.start.point
							shape.props.start = {
								type: 'point',
								x,
								y,
							}
						} else {
							const { start } = getArrowTerminalsInArrowSpace(this, shape)
							shape.props.start = {
								type: 'point',
								x: start.x,
								y: start.y,
							}
						}
					}
				}

				if (shape.props.end.type === 'binding') {
					if (!shapes.some((s) => s.id === endBindingId)) {
						if (info?.isValid) {
							const { x, y } = info.end.point
							shape.props.end = {
								type: 'point',
								x,
								y,
							}
						} else {
							const { end } = getArrowTerminalsInArrowSpace(this, shape)
							shape.props.end = {
								type: 'point',
								x: end.x,
								y: end.y,
							}
						}
					}
				}

				const infoAfter = getIsArrowStraight(shape)
					? getStraightArrowInfo(this, shape)
					: getCurvedArrowInfo(this, shape)

				if (info?.isValid && infoAfter?.isValid && !getIsArrowStraight(shape)) {
					const mpA = Vec2d.Med(info.start.handle, info.end.handle)
					const distA = Vec2d.Dist(info.middle, mpA)
					const distB = Vec2d.Dist(infoAfter.middle, mpA)
					if (shape.props.bend < 0) {
						shape.props.bend += distB - distA
					} else {
						shape.props.bend -= distB - distA
					}
				}

				return shape
			}

			return shape
		})

		const rootShapeIds: TLShapeId[] = []

		shapes.forEach((shape) => {
			if (shapes.find((s) => s.id === shape.parentId) === undefined) {
				// Need to get page point and rotation of the shape because shapes in
				// groups use local position/rotation

				const pagePoint = this.getPagePointById(shape.id)!
				const pageRotation = this.getPageRotationById(shape.id)!
				shape.x = pagePoint.x
				shape.y = pagePoint.y
				shape.rotation = pageRotation
				shape.parentId = this.currentPageId

				rootShapeIds.push(shape.id)
			}
		})

		const assetsSet = new Set<TLAssetId>()

		shapes.forEach((shape) => {
			if ('assetId' in shape.props) {
				if (shape.props.assetId !== null) {
					assetsSet.add(shape.props.assetId)
				}
			}
		})

		return {
			shapes,
			rootShapeIds,
			schema: this.store.schema.serialize(),
			assets: compact(Array.from(assetsSet).map((id) => this.getAssetById(id))),
		}
	}

	/* --------------------- Commands --------------------- */

	/**
	 * Place content into the editor.
	 *
	 * @param content - The content.
	 * @param options - Options for placing the content.
	 *
	 * @public
	 */
	putContent(
		content: TLContent,
		options: {
			point?: VecLike
			select?: boolean
			preservePosition?: boolean
			preserveIds?: boolean
		} = {}
	): this {
		if (this.isReadOnly) return this

		if (!content.schema) {
			throw Error('Could not put content: content is missing a schema.')
		}

		const { select = false, preserveIds = false, preservePosition = false } = options
		let { point = undefined } = options

		// decide on a parent for the put shapes; if the parent is among the put shapes(?) then use its parent

		const { currentPageId } = this
		const { assets, shapes, rootShapeIds } = content

		const idMap = new Map<any, TLShapeId>(shapes.map((shape) => [shape.id, createShapeId()]))

		// By default, the paste parent will be the current page.
		let pasteParentId = this.currentPageId as TLPageId | TLShapeId
		let lowestDepth = Infinity
		let lowestAncestors: TLShape[] = []

		// Among the selected shapes, find the shape with the fewest ancestors and use its first ancestor.
		for (const shape of this.selectedShapes) {
			if (lowestDepth === 0) break

			const ancestors = this.getAncestors(shape)
			if (shape.type === 'frame') ancestors.push(shape)

			const depth = shape.type === 'frame' ? ancestors.length + 1 : ancestors.length

			if (depth < lowestDepth) {
				lowestDepth = depth
				lowestAncestors = ancestors
				pasteParentId = shape.type === 'frame' ? shape.id : shape.parentId
			} else if (depth === lowestDepth) {
				if (lowestAncestors.length !== ancestors.length) {
					throw Error(`Ancestors: ${lowestAncestors.length} !== ${ancestors.length}`)
				}

				if (lowestAncestors.length === 0) {
					pasteParentId = currentPageId
					break
				} else {
					pasteParentId = currentPageId
					for (let i = 0; i < lowestAncestors.length; i++) {
						if (ancestors[i] !== lowestAncestors[i]) break
						pasteParentId = ancestors[i].id
					}
				}
			}
		}

		let isDuplicating = false

		if (!isPageId(pasteParentId)) {
			const parent = this.getShapeById(pasteParentId)
			if (parent) {
				if (!this.viewportPageBounds.includes(this.getPageBounds(parent)!)) {
					pasteParentId = currentPageId
				} else {
					if (rootShapeIds.length === 1) {
						const rootShape = shapes.find((s) => s.id === rootShapeIds[0])!
						if (
							this.isShapeOfType(parent, FrameShapeUtil) &&
							this.isShapeOfType(rootShape, FrameShapeUtil) &&
							rootShape.props.w === parent?.props.w &&
							rootShape.props.h === parent?.props.h
						) {
							isDuplicating = true
						}
					}
				}
			} else {
				pasteParentId = currentPageId
			}
		}

		if (!isDuplicating) {
			isDuplicating = idMap.has(pasteParentId)
		}

		if (isDuplicating) {
			pasteParentId = this.getShapeById(pasteParentId)!.parentId
		}

		let index = this.getHighestIndexForParent(pasteParentId)

		const rootShapes: TLShape[] = []

		const newShapes: TLShape[] = shapes.map((shape): TLShape => {
			let newShape: TLShape

			if (preserveIds) {
				newShape = deepCopy(shape)
				idMap.set(shape.id, shape.id)
			} else {
				const id = idMap.get(shape.id)!

				// Create the new shape (new except for the id)
				newShape = deepCopy({ ...shape, id })
			}

			if (rootShapeIds.includes(shape.id)) {
				newShape.parentId = currentPageId
				rootShapes.push(newShape)
			}

			// Assign the child to its new parent.

			// If the child's parent is among the putting shapes, then assign
			// it to the new parent's id.
			if (idMap.has(newShape.parentId)) {
				newShape.parentId = idMap.get(shape.parentId)!
			} else {
				rootShapeIds.push(newShape.id)
				// newShape.parentId = pasteParentId
				newShape.index = index
				index = getIndexAbove(index)
			}

			if (this.isShapeOfType(newShape, ArrowShapeUtil)) {
				if (newShape.props.start.type === 'binding') {
					const mappedId = idMap.get(newShape.props.start.boundShapeId)
					newShape.props.start = mappedId
						? { ...newShape.props.start, boundShapeId: mappedId }
						: // this shouldn't happen, if you copy an arrow but not it's bound shape it should
						  // convert the binding to a point at the time of copying
						  { type: 'point', x: 0, y: 0 }
				}
				if (newShape.props.end.type === 'binding') {
					const mappedId = idMap.get(newShape.props.end.boundShapeId)
					newShape.props.end = mappedId
						? { ...newShape.props.end, boundShapeId: mappedId }
						: // this shouldn't happen, if you copy an arrow but not it's bound shape it should
						  // convert the binding to a point at the time of copying
						  { type: 'point', x: 0, y: 0 }
				}
			}

			return newShape
		})

		if (newShapes.length + this.shapeIds.size > MAX_SHAPES_PER_PAGE) {
			// There's some complexity here involving children
			// that might be created without their parents, so
			// if we're going over the limit then just don't paste.
			alertMaxShapes(this)
			return this
		}

		// Migrate the new shapes

		let assetsToCreate: TLAsset[] = []

		if (assets) {
			for (let i = 0; i < assets.length; i++) {
				const asset = assets[i]
				const result = this.store.schema.migratePersistedRecord(asset, content.schema)
				if (result.type === 'success') {
					assets[i] = result.value as TLAsset
				} else {
					throw Error(
						`Could not put content: could not migrate content for asset:\n${JSON.stringify(
							asset,
							null,
							2
						)}`
					)
				}
			}

			const assetsToUpdate: (TLImageAsset | TLVideoAsset)[] = []

			assetsToCreate = assets
				.filter((asset) => !this.store.has(asset.id))
				.map((asset) => {
					if (asset.type === 'image' || asset.type === 'video') {
						if (asset.props.src && asset.props.src?.startsWith('data:image')) {
							assetsToUpdate.push(structuredClone(asset))
							asset.props.src = null
						} else {
							assetsToUpdate.push(structuredClone(asset))
						}
					}

					return asset
				})

			Promise.allSettled(
				assetsToUpdate.map(async (asset) => {
					const file = await dataUrlToFile(
						asset.props.src!,
						asset.props.name,
						asset.props.mimeType ?? 'image/png'
					)

					const newAsset = await this.externalContentManager.createAssetFromFile(this, file)

					return [asset, newAsset] as const
				})
			).then((assets) => {
				this.updateAssets(
					compact(
						assets.map((result) =>
							result.status === 'fulfilled'
								? { ...result.value[1], id: result.value[0].id }
								: undefined
						)
					)
				)
			})
		}

		for (let i = 0; i < newShapes.length; i++) {
			const shape = newShapes[i]
			const result = this.store.schema.migratePersistedRecord(shape, content.schema)
			if (result.type === 'success') {
				newShapes[i] = result.value as TLShape
			} else {
				throw Error(
					`Could not put content: could not migrate content for shape:\n${JSON.stringify(
						shape,
						null,
						2
					)}`
				)
			}
		}

		this.batch(() => {
			// Create any assets that need to be created
			if (assetsToCreate.length > 0) {
				this.createAssets(assetsToCreate)
			}

			// Create the shapes with root shapes as children of the page
			this.createShapes(newShapes, select)

			// And then, if needed, reparent the root shapes to the paste parent
			if (pasteParentId !== currentPageId) {
				this.reparentShapesById(
					rootShapes.map((s) => s.id),
					pasteParentId
				)
			}

			const newCreatedShapes = newShapes.map((s) => this.getShapeById(s.id)!)
			const bounds = Box2d.Common(newCreatedShapes.map((s) => this.getPageBounds(s)!))

			if (point === undefined) {
				if (!isPageId(pasteParentId)) {
					// Put the shapes in the middle of the (on screen) parent
					const shape = this.getShapeById(pasteParentId)!
					const util = this.getShapeUtil(shape)
					point = util.center(shape)
				} else {
					const { viewportPageBounds } = this
					if (preservePosition || viewportPageBounds.includes(Box2d.From(bounds))) {
						// Otherwise, put shapes where they used to be
						point = bounds.center
					} else {
						// If the old bounds are outside of the viewport...
						// put the shapes in the middle of the viewport
						point = viewportPageBounds.center
					}
				}
			}

			if (rootShapes.length === 1) {
				const onlyRoot = rootShapes[0] as TLFrameShape
				// If the old bounds are in the viewport...
				if (onlyRoot.type === 'frame') {
					while (
						this.getShapesAtPoint(point).some(
							(shape) =>
								this.isShapeOfType(shape, FrameShapeUtil) &&
								shape.props.w === onlyRoot.props.w &&
								shape.props.h === onlyRoot.props.h
						)
					) {
						point.x += bounds.w + 16
					}
				}
			}

			this.updateShapes(
				rootShapes.map((s) => {
					const delta = {
						x: (s.x ?? 0) - (bounds.x + bounds.w / 2),
						y: (s.y ?? 0) - (bounds.y + bounds.h / 2),
					}

					return { id: s.id, type: s.type, x: point!.x + delta.x, y: point!.y + delta.y }
				})
			)
		})

		return this
	}

	/* --------------------- Shapes --------------------- */

	/**
	 * Get the index above the highest child of a given parent.
	 *
	 * @param parentId - The id of the parent.
	 *
	 * @returns The index.
	 *
	 * @public
	 */
	getHighestIndexForParent(parentId: TLShapeId | TLPageId) {
		const children = this._parentIdsToChildIds.value[parentId]

		if (!children || children.length === 0) {
			return 'a1'
		}
		return getIndexAbove(children[children.length - 1][1])
	}

	/**
	 * Create shapes.
	 *
	 * @example
	 * ```ts
	 * editor.createShapes([{ id: 'box1', type: 'text', props: { text: "ok" } }])
	 * ```
	 *
	 * @param partials - The shape partials to create.
	 * @param select - Whether to select the created shapes. Defaults to false.
	 *
	 * @public
	 */
	createShapes<T extends TLUnknownShape>(partials: TLShapePartial<T>[], select = false) {
		this._createShapes(partials, select)
		return this
	}

	/** @internal */
	private _createShapes = this.history.createCommand(
		'createShapes',
		(partials: TLShapePartial[], select = false) => {
			if (this.isReadOnly) return null
			if (partials.length <= 0) return null

			const { shapeIds, selectedIds } = this

			const prevSelectedIds = select ? selectedIds : undefined

			const maxShapesReached = partials.length + shapeIds.size > MAX_SHAPES_PER_PAGE

			if (maxShapesReached) {
				alertMaxShapes(this)
			}

			const partialsToCreate = maxShapesReached
				? partials.slice(0, MAX_SHAPES_PER_PAGE - shapeIds.size)
				: partials

			if (partialsToCreate.length === 0) return null

			return {
				data: {
					currentPageId: this.currentPageId,
					createdIds: partials.map((p) => p.id),
					prevSelectedIds,
					partials: partialsToCreate,
					select,
				},
			}
		},
		{
			do: ({ createdIds, partials, select }) => {
				const { focusLayerId } = this

				// 1. Parents

				// Make sure that each partial will become the child of either the
				// page or another shape that exists (or that will exist) in this page.

				partials = partials.map((partial) => {
					if (
						// No parentId provided
						!partial.parentId ||
						// A parentId is proved but the parent is neither a) in the store
						// or b) among the other creating shape partials
						(!this.store.get(partial.parentId) && !partials.find((p) => p.id === partial.parentId))
					) {
						partial = { ...partial }
						const parentId = this.getParentIdForNewShapeAtPoint(
							{ x: partial.x ?? 0, y: partial.y ?? 0 },
							partial.type
						)
						partial.parentId = parentId
						// If the parent is a shape (rather than a page) then insert the
						// shapes into the shape's children. Adjust the point and page rotation to be
						// preserved relative to the parent.
						if (isShapeId(parentId)) {
							const point = this.getPointInShapeSpace(this.getShapeById(parentId)!, {
								x: partial.x ?? 0,
								y: partial.y ?? 0,
							})
							partial.x = point.x
							partial.y = point.y
							partial.rotation = -this.getPageRotationById(parentId) + (partial.rotation ?? 0)
						}
						// a shape cannot be it's own parent. This was a rare issue with frames/groups in the syncFuzz tests.
						if (partial.parentId === partial.id) {
							partial.parentId = focusLayerId
						}
						return partial
					}
					return partial
				})

				// 2. Indices

				// Get the highest index among the parents of each of the
				// the shapes being created; we'll increment from there.

				const parentIndices = new Map<string, string>()

				const shapeRecordsToCreate: TLShape[] = []

				for (const partial of partials) {
					const util = this.getShapeUtil(partial)

					// If an index is not explicitly provided, then add the
					// shapes to the top of their parents' children; using the
					// value in parentsMappedToIndex, get the index above, use it,
					// and set it back to parentsMappedToIndex for next time.
					let index = partial.index

					if (!index) {
						const parentId = partial.parentId ?? focusLayerId
						if (!parentIndices.has(parentId)) {
							parentIndices.set(parentId, this.getHighestIndexForParent(parentId))
						}
						index = parentIndices.get(parentId)!
						parentIndices.set(parentId, getIndexAbove(index))
					}

					// The initial props starts as the shape utility's default props
					const initialProps = util.defaultProps()

					// We then look up each key in the tab state's props; and if it's there,
					// we use the value from the tab state's props instead of the default.
					// Note that props will never include opacity.
					const { propsForNextShape, opacityForNextShape } = this.instanceState
					for (const key in initialProps) {
						if (key in propsForNextShape) {
							if (key === 'url') continue
							;(initialProps as any)[key] = (propsForNextShape as any)[key]
						}
					}

					// When we create the shape, take in the partial (the props coming into the
					// function) and merge it with the default props.
					let shapeRecordToCreate = (
						this.store.schema.types.shape as RecordType<
							TLShape,
							'type' | 'props' | 'index' | 'parentId'
						>
					).create({
						...partial,
						index,
						opacity: partial.opacity ?? opacityForNextShape,
						parentId: partial.parentId ?? focusLayerId,
						props: 'props' in partial ? { ...initialProps, ...partial.props } : initialProps,
					})

					if (shapeRecordToCreate.index === undefined) {
						throw Error('no index!')
					}

					const next = this.getShapeUtil(shapeRecordToCreate).onBeforeCreate?.(shapeRecordToCreate)

					if (next) {
						shapeRecordToCreate = next
					}

					shapeRecordsToCreate.push(shapeRecordToCreate)
				}

				this.store.put(shapeRecordsToCreate)

				// If we're also selecting the newly created shapes, attempt to select all of them;

				// the engine will filter out any shapes that are descendants of other new shapes.
				if (select) {
					this.store.update(this.pageState.id, (state) => ({
						...state,
						selectedIds: createdIds,
					}))
				}
			},
			undo: ({ createdIds, prevSelectedIds }) => {
				this.store.remove(createdIds)

				if (prevSelectedIds) {
					this.store.update(this.pageState.id, (state) => ({
						...state,
						selectedIds: prevSelectedIds,
					}))
				}
			},
		}
	)

	private animatingShapes = new Map<TLShapeId, string>()

	/**
	 * Animate shapes.
	 *
	 * @example
	 * ```ts
	 * editor.animateShapes([{ id: 'box1', type: 'box', x: 100, y: 100 }])
	 * ```
	 *
	 * @param partials - The shape partials to update.
	 *
	 * @public
	 */
	animateShapes(
		partials: (TLShapePartial | null | undefined)[],
		options: {
			/** The animation's duration in milliseconds. */
			duration?: number
			/** The animation's easing function. */
			ease?: (t: number) => number
		} = {}
	) {
		const { duration = 500, ease = EASINGS.linear } = options

		const animationId = uniqueId()

		let remaining = duration
		let t: number

		type FromTo = { prop: string; from: number; to: number }
		type ShapeAnimation = { partial: TLShapePartial; values: FromTo[] }

		const animations: ShapeAnimation[] = []

		partials.forEach((partial) => {
			if (!partial) return

			const result: ShapeAnimation = {
				partial,
				values: [],
			}

			const shape = this.getShapeById(partial.id)!

			if (!shape) return

			for (const key of ['x', 'y', 'rotation'] as const) {
				if (partial[key] !== undefined && shape[key] !== partial[key]) {
					result.values.push({ prop: key, from: shape[key], to: partial[key] as number })
				}
			}

			animations.push(result)
			this.animatingShapes.set(shape.id, animationId)
		})

		let value: ShapeAnimation

		const handleTick = (elapsed: number) => {
			remaining -= elapsed

			if (remaining < 0) {
				const { animatingShapes } = this
				const partialsToUpdate = partials.filter(
					(p) => p && animatingShapes.get(p.id) === animationId
				)
				if (partialsToUpdate.length) {
					this.updateShapes(partialsToUpdate, false)
					// update shapes also removes the shape from animating shapes
				}

				this.removeListener('tick', handleTick)
				return
			}

			t = ease(1 - remaining / duration)

			const { animatingShapes } = this

			try {
				const tPartials: TLShapePartial[] = []

				for (let i = 0; i < animations.length; i++) {
					value = animations[i]

					if (animatingShapes.get(value.partial.id) === animationId) {
						tPartials.push({
							id: value.partial.id,
							type: value.partial.type,
							...value.values.reduce((acc, { prop, from, to }) => {
								acc[prop] = from + (to - from) * t
								return acc
							}, {} as any),
						})
					}
				}

				this._updateShapes(tPartials, true)
			} catch (e) {
				// noop
			}
		}

		this.addListener('tick', handleTick)

		return this
	}

	/**
	 * Update shapes using partials of each shape.
	 *
	 * @example
	 * ```ts
	 * editor.updateShapes([{ id: 'box1', type: 'geo', props: { w: 100, h: 100 } }])
	 * ```
	 *
	 * @param partials - The shape partials to update.
	 * @param squashing - Whether the change is ephemeral.
	 *
	 * @public
	 */
	updateShapes<T extends TLUnknownShape>(
		partials: (TLShapePartial<T> | null | undefined)[],
		squashing = false
	) {
		let compactedPartials = compact(partials)
		if (this.animatingShapes.size > 0) {
			compactedPartials.forEach((p) => this.animatingShapes.delete(p.id))
		}

		compactedPartials = compactedPartials.filter((p) => {
			const shape = this.getShapeById(p.id)
			if (!shape) return false

			// Only allow changes to unlocked shapes or changes to the isLocked property (otherwise we cannot unlock a shape)
			if (this.isShapeOrAncestorLocked(shape) && !Object.hasOwn(p, 'isLocked')) return false
			return true
		})

		this._updateShapes(compactedPartials, squashing)
		return this
	}

	/** @internal */
	private _updateShapes = this.history.createCommand(
		'updateShapes',
		(_partials: (TLShapePartial | null | undefined)[], squashing = false) => {
			if (this.isReadOnly) return null

			const partials = compact(_partials)

			const snapshots = Object.fromEntries(
				compact(partials.map(({ id }) => this.getShapeById(id))).map((shape) => {
					return [shape.id, shape]
				})
			)

			if (partials.length <= 0) return null

			const updated = compact(
				partials.map((partial) => {
					const prev = snapshots[partial.id]
					if (!prev) return null
					let newRecord = null as null | TLShape
					for (const [k, v] of Object.entries(partial)) {
						if (v === undefined) continue
						switch (k) {
							case 'id':
							case 'type':
							case 'typeName': {
								continue
							}
							default: {
								if (v !== (prev as any)[k]) {
									if (!newRecord) {
										newRecord = { ...prev }
									}

									if (k === 'props') {
										const nextProps = { ...prev.props } as Record<string, unknown>
										for (const [propKey, propValue] of Object.entries(v as object)) {
											if (propValue === undefined) continue
											nextProps[propKey] = propValue
										}
										newRecord!.props = nextProps
									} else {
										;(newRecord as any)[k] = v
									}
								}
							}
						}
					}

					return newRecord ?? prev
				})
			)

			const updates = Object.fromEntries(updated.map((shape) => [shape.id, shape]))

			return { data: { snapshots, updates }, squashing }
		},
		{
			do: ({ updates }) => {
				// Iterate through array; if any shape has an onUpdate handler, call it
				// and, if the handler returns a new shape, replace the old shape with
				// the new one. This is used for example when repositioning a text shape
				// based on its new text content.
				const result = Object.values(updates)
				for (let i = 0; i < result.length; i++) {
					const shape = result[i]
					const current = this.store.get(shape.id)
					if (!current) continue
					const next = this.getShapeUtil(shape).onBeforeUpdate?.(current, shape)
					if (next) {
						result[i] = next
					}
				}
				this.store.put(result)
			},
			undo: ({ snapshots }) => {
				this.store.put(Object.values(snapshots))
			},
			squash(prevData, nextData) {
				return {
					// keep the oldest snapshots
					snapshots: { ...nextData.snapshots, ...prevData.snapshots },
					// keep the newest updates
					updates: { ...prevData.updates, ...nextData.updates },
				}
			},
		}
	)

	/** @internal */
	private _getUnlockedShapeIds(ids: TLShapeId[]): TLShapeId[] {
		return ids.filter((id) => !this.getShapeById(id)?.isLocked)
	}

	/**
	 * Delete shapes.
	 *
	 * @example
	 * ```ts
	 * editor.deleteShapes()
	 * editor.deleteShapes(['box1', 'box2'])
	 * ```
	 *
	 * @param ids - The ids of the shapes to delete. Defaults to the selected shapes.
	 *
	 * @public
	 */
	deleteShapes(ids: TLShapeId[] = this.selectedIds) {
		this._deleteShapes(this._getUnlockedShapeIds(ids))
		return this
	}

	/** @internal */
	private _deleteShapes = this.history.createCommand(
		'delete_shapes',
		(ids: TLShapeId[]) => {
			if (this.isReadOnly) return null
			if (ids.length === 0) return null
			const prevSelectedIds = [...this.pageState.selectedIds]

			const allIds = new Set(ids)

			for (const id of ids) {
				this.visitDescendants(id, (childId) => {
					allIds.add(childId)
				})
			}

			const deletedIds = [...allIds]
			const arrowBindings = this._arrowBindingsIndex.value
			const snapshots = compact(
				deletedIds.flatMap((id) => {
					const shape = this.getShapeById(id)

					// Add any bound arrows to the snapshots, so that we can restore the bindings on undo
					const bindings = arrowBindings[id]
					if (bindings && bindings.length > 0) {
						return bindings.map(({ arrowId }) => this.getShapeById(arrowId)).concat(shape)
					}
					return shape
				})
			)

			const postSelectedIds = prevSelectedIds.filter((id) => !allIds.has(id))

			return { data: { deletedIds, snapshots, prevSelectedIds, postSelectedIds } }
		},
		{
			do: ({ deletedIds, postSelectedIds }) => {
				this.store.remove(deletedIds)
				this.store.update(this.pageState.id, (state) => ({
					...state,
					selectedIds: postSelectedIds,
				}))
			},
			undo: ({ snapshots, prevSelectedIds }) => {
				this.store.put(snapshots)
				this.store.update(this.pageState.id, (state) => ({
					...state,
					selectedIds: prevSelectedIds,
				}))
			},
		}
	)

	/**
	 * Get the user's locale.
	 *
	 * @public
	 */
	get locale() {
		return this.user.locale
	}

	/**
	 * Update the user's locale. This affects which translations are used when rendering UI elements.
	 *
	 * @example
	 * ```ts
	 * editor.setLocale('fr')
	 * ```
	 *
	 * @public
	 */
	setLocale(locale: string) {
		this.user.updateUserPreferences({ locale })
	}

	/**
	 * Update a page.
	 *
	 * @example
	 * ```ts
	 * editor.updatePage({ id: 'page2', name: 'Page 2' })
	 * ```
	 *
	 * @param partial - The partial of the shape to update.
	 *
	 * @public
	 */
	updatePage(partial: RequiredKeys<TLPage, 'id'>, squashing = false) {
		this._updatePage(partial, squashing)
		return this
	}

	/** @internal */
	private _updatePage = this.history.createCommand(
		'updatePage',
		(partial: RequiredKeys<TLPage, 'id'>, squashing = false) => {
			if (this.isReadOnly) return null

			const prev = this.getPageById(partial.id)

			if (!prev) return null

			return { data: { prev, partial }, squashing }
		},
		{
			do: ({ partial }) => {
				this.store.update(partial.id, (page) => ({ ...page, ...partial }))
			},
			undo: ({ prev, partial }) => {
				this.store.update(partial.id, () => prev)
			},
			squash(prevData, nextData) {
				return {
					prev: { ...prevData.prev, ...nextData.prev },
					partial: nextData.partial,
				}
			},
		}
	)

	/**
	 * Create a page.
	 *
	 * @example
	 * ```ts
	 * editor.createPage('New Page')
	 * editor.createPage('New Page', 'page1')
	 * ```
	 *
	 * @param id - The new page's id.
	 * @param title - The new page's title.
	 *
	 * @public
	 */
	createPage(title: string, id: TLPageId = PageRecordType.createId(), belowPageIndex?: string) {
		this._createPage(title, id, belowPageIndex)
		return this
	}

	/** @internal */
	private _createPage = this.history.createCommand(
		'createPage',
		(title: string, id: TLPageId = PageRecordType.createId(), belowPageIndex?: string) => {
			if (this.isReadOnly) return null
			if (this.pages.length >= MAX_PAGES) return null
			const pageInfo = this.pages
			const topIndex = belowPageIndex ?? pageInfo[pageInfo.length - 1]?.index ?? 'a1'
			const bottomIndex = pageInfo[pageInfo.findIndex((p) => p.index === topIndex) + 1]?.index

			title = getIncrementedName(
				title,
				pageInfo.map((p) => p.name)
			)

			const newPage = PageRecordType.create({
				id,
				name: title,
				index:
					bottomIndex && topIndex !== bottomIndex
						? getIndexBetween(topIndex, bottomIndex)
						: getIndexAbove(topIndex),
			})

			const newCamera = CameraRecordType.create({
				id: CameraRecordType.createId(newPage.id),
			})

			const newTabPageState = InstancePageStateRecordType.create({
				id: InstancePageStateRecordType.createId(newPage.id),
				pageId: newPage.id,
			})

			return {
				data: {
					prevSelectedPageId: this.currentPageId,
					newPage,
					newTabPageState,
					newCamera,
				},
			}
		},
		{
			do: ({ newPage, newTabPageState, newCamera }) => {
				this.store.put([
					newPage,
					newCamera,
					newTabPageState,
					{ ...this.instanceState, currentPageId: newPage.id },
				])
				this.updateCullingBounds()
			},
			undo: ({ newPage, prevSelectedPageId, newTabPageState, newCamera }) => {
				if (this.pages.length === 1) return
				this.store.remove([newTabPageState.id, newPage.id, newCamera.id])

				if (this.store.has(prevSelectedPageId) && this.currentPageId !== prevSelectedPageId) {
					this.store.put([{ ...this.instanceState, currentPageId: prevSelectedPageId }])
				}

				this.updateCullingBounds()
			},
		}
	)

	/**
	 * Duplicate a page.
	 *
	 * @param id - The id of the page to duplicate. Defaults to the current page.
	 * @param createId - The id of the new page. Defaults to a new id.
	 *
	 * @public
	 */
	duplicatePage(id: TLPageId = this.currentPageId, createId: TLPageId = PageRecordType.createId()) {
		if (this.pages.length >= MAX_PAGES) return this
		const page = this.getPageById(id)
		if (!page) return this

		const camera = { ...this.camera }
		const content = this.getContent(this.getSortedChildIds(page.id))

		this.batch(() => {
			this.createPage(page.name + ' Copy', createId, page.index)
			this.setCurrentPageId(createId)
			this.setCamera(camera.x, camera.y, camera.z)

			// will change page automatically
			if (content) {
				return this.putContent(content)
			}
		})

		return this
	}

	/**
	 * Delete a page.
	 *
	 * @example
	 * ```ts
	 * editor.deletePage('page1')
	 * ```
	 *
	 * @param id - The id of the page to delete.
	 *
	 * @public
	 */
	deletePage(id: TLPageId) {
		this._deletePage(id)
	}

	/** @internal */
	private _deletePage = this.history.createCommand(
		'delete_page',
		(id: TLPageId) => {
			if (this.isReadOnly) return null
			const { pages } = this
			if (pages.length === 1) return null

			const deletedPage = this.getPageById(id)
			const deletedPageStates = this._pageStates.value.filter((s) => s.pageId === id)

			if (!deletedPage) return null

			if (id === this.currentPageId) {
				const index = pages.findIndex((page) => page.id === id)
				const next = pages[index - 1] ?? pages[index + 1]
				this.setCurrentPageId(next.id)
			}

			return { data: { id, deletedPage, deletedPageStates } }
		},
		{
			do: ({ deletedPage, deletedPageStates }) => {
				const { pages } = this
				if (pages.length === 1) return

				if (deletedPage.id === this.currentPageId) {
					const index = pages.findIndex((page) => page.id === deletedPage.id)
					const next = pages[index - 1] ?? pages[index + 1]
					this.setCurrentPageId(next.id)
				}

				this.store.remove(deletedPageStates.map((s) => s.id)) // remove the page state
				this.store.remove([deletedPage.id]) // remove the page
				this.updateCullingBounds()
			},
			undo: ({ deletedPage, deletedPageStates }) => {
				this.store.put([deletedPage])
				this.store.put(deletedPageStates)
				this.updateCullingBounds()
			},
		}
	)

	/**
	 * Update a page state.
	 *
	 * @example
	 * ```ts
	 * editor.setInstancePageState({ id: 'page1', editingId: 'shape:123' })
	 * editor.setInstancePageState({ id: 'page1', editingId: 'shape:123' }, true)
	 * ```
	 *
	 * @param partial - The partial of the page state object containing the changes.
	 * @param ephemeral - Whether the command is ephemeral.
	 *
	 * @public
	 */
	setInstancePageState(partial: Partial<TLInstancePageState>, ephemeral = false) {
		this._setInstancePageState(partial, ephemeral)
	}

	/** @internal */
	private _setInstancePageState = this.history.createCommand(
		'setInstancePageState',
		(partial: Partial<TLInstancePageState>, ephemeral = false) => {
			const prev = this.store.get(partial.id ?? this.pageState.id)!
			return { data: { prev, partial }, ephemeral }
		},
		{
			do: ({ prev, partial }) => {
				this.store.update(prev.id, (state) => ({ ...state, ...partial }))
			},
			undo: ({ prev }) => {
				this.store.update(prev.id, () => prev)
			},
		}
	)

	/**
	 * Select one or more shapes.
	 *
	 * @example
	 * ```ts
	 * editor.setSelectedIds(['id1'])
	 * editor.setSelectedIds(['id1', 'id2'])
	 * ```
	 *
	 * @param ids - The ids to select.
	 * @param squashing - Whether the change should create a new history entry or combine with the
	 *   previous (if the previous is the same type).
	 *
	 * @public
	 */
	setSelectedIds(ids: TLShapeId[], squashing = false) {
		this._setSelectedIds(ids, squashing)
		return this
	}

	/** @internal */
	private _setSelectedIds = this.history.createCommand(
		'setSelectedIds',
		(ids: TLShapeId[], squashing = false) => {
			const prevSelectedIds = this.pageState.selectedIds

			const prevSet = new Set(this.pageState.selectedIds)

			if (ids.length === prevSet.size && ids.every((id) => prevSet.has(id))) return null

			return { data: { ids, prevSelectedIds }, squashing, preservesRedoStack: true }
		},
		{
			do: ({ ids }) => {
				this.store.update(this.pageState.id, (state) => ({ ...state, selectedIds: ids }))
			},
			undo: ({ prevSelectedIds }) => {
				this.store.update(this.pageState.id, () => ({
					...this.pageState,
					selectedIds: prevSelectedIds,
				}))
			},
			squash(prev, next) {
				return { ids: next.ids, prevSelectedIds: prev.prevSelectedIds }
			},
		}
	)

	/**
	 * Determine whether or not a shape is selected
	 *
	 * @example
	 * ```ts
	 * editor.isSelected('id1')
	 * ```
	 *
	 * @param id - The id of the shape to check.
	 *
	 * @public
	 */
	isSelected(id: TLShapeId) {
		return this.selectedIdsSet.has(id)
	}

	/**
	 * Determine whether a not a shape is within the current selection. A shape is within the
	 * selection if it or any of its parents is selected.
	 *
	 * @param id - The id of the shape to check.
	 *
	 * @public
	 */
	isWithinSelection(id: TLShapeId) {
		const shape = this.getShapeById(id)
		if (!shape) return false

		if (this.isSelected(id)) return true

		return !!this.findAncestor(shape, (parent) => this.isSelected(parent.id))
	}

	/* --------------------- Assets --------------------- */

	/** @internal */
	@computed private get _assets() {
		return this.store.query.records('asset')
	}

	/**
	 * Get all assets in the editor.
	 *
	 * @public
	 */
	get assets() {
		return this._assets.value
	}

	/**
	 * Create one or more assets.
	 *
	 * @example
	 * ```ts
	 * editor.createAssets([...myAssets])
	 * ```
	 *
	 * @param assets - The assets to create.
	 *
	 * @public
	 */
	createAssets(assets: TLAsset[]) {
		this._createAssets(assets)
		return this
	}

	/** @internal */
	private _createAssets = this.history.createCommand(
		'createAssets',
		(assets: TLAsset[]) => {
			if (this.isReadOnly) return null
			if (assets.length <= 0) return null

			return { data: { assets } }
		},
		{
			do: ({ assets }) => {
				this.store.put(assets)
			},
			undo: ({ assets }) => {
				// todo: should we actually remove assets here? or on cleanup elsewhere?
				this.store.remove(assets.map((a) => a.id))
			},
		}
	)

	/**
	 * Delete one or more assets.
	 *
	 * @example
	 * ```ts
	 * editor.deleteAssets(['asset1', 'asset2'])
	 * ```
	 *
	 * @param ids - The assets to delete.
	 *
	 * @public
	 */
	deleteAssets(ids: TLAssetId[]) {
		this._deleteAssets(ids)
		return this
	}

	/** @internal */
	private _deleteAssets = this.history.createCommand(
		'deleteAssets',
		(ids: TLAssetId[]) => {
			if (this.isReadOnly) return
			if (ids.length <= 0) return

			const prev = compact(ids.map((id) => this.store.get(id)))

			return { data: { ids, prev } }
		},
		{
			do: ({ ids }) => {
				this.store.remove(ids)
			},
			undo: ({ prev }) => {
				this.store.put(prev)
			},
		}
	)

	/**
	 * Update one or more assets.
	 *
	 * @example
	 * ```ts
	 * editor.updateAssets([{ id: 'asset1', name: 'New name' }])
	 * ```
	 *
	 * @param assets - The assets to update.
	 *
	 * @public
	 */
	updateAssets(assets: TLAssetPartial[]) {
		this._updateAssets(assets)
		return this
	}

	/** @internal */
	private _updateAssets = this.history.createCommand(
		'updateAssets',
		(assets: TLAssetPartial[]) => {
			if (this.isReadOnly) return
			if (assets.length <= 0) return

			const snapshots: Record<string, TLAsset> = {}

			return { data: { snapshots, assets } }
		},
		{
			do: ({ assets, snapshots }) => {
				this.store.put(
					assets.map((a) => {
						const asset = this.store.get(a.id)!
						snapshots[a.id] = asset

						return {
							...asset,
							...a,
						}
					})
				)
			},
			undo: ({ snapshots }) => {
				this.store.put(Object.values(snapshots))
			},
		}
	)

	/**
	 * Get an asset by its src property.
	 *
	 * @example
	 * ```ts
	 * editor.getAssetBySource('https://example.com/image.png')
	 * ```
	 *
	 * @param src - The source value of the asset.
	 *
	 * @public
	 */
	getAssetBySrc(src: string) {
		return this.assets.find((a) => a.props.src === src)
	}

	/**
	 * Get an asset by its id.
	 *
	 * @example
	 * ```ts
	 * editor.getAssetById('asset1')
	 * ```
	 *
	 * @param id - The id of the asset.
	 *
	 * @public
	 */
	getAssetById(id: TLAssetId): TLAsset | undefined {
		return this.store.get(id) as TLAsset | undefined
	}

	/* ------------------- SubCommands ------------------ */
	/**
	 * Get an exported SVG of the given shapes.
	 *
	 * @param ids - The ids of the shapes to export. Defaults to selected shapes.
	 * @param opts - Options for the export.
	 *
	 * @returns The SVG element.
	 *
	 * @public
	 */
	async getSvg(
		ids: TLShapeId[] = this.selectedIds.length
			? this.selectedIds
			: (Object.keys(this.shapeIds) as TLShapeId[]),
		opts = {} as Partial<{
			scale: number
			background: boolean
			padding: number
			darkMode?: boolean
			preserveAspectRatio: React.SVGAttributes<SVGSVGElement>['preserveAspectRatio']
		}>
	) {
		if (ids.length === 0) return
		if (!window.document) throw Error('No document')

		const {
			scale = 1,
			background = false,
			padding = SVG_PADDING,
			darkMode = this.isDarkMode,
			preserveAspectRatio = false,
		} = opts

		const realContainerEl = this.getContainer()
		const realContainerStyle = getComputedStyle(realContainerEl)

		// Get the styles from the container. We'll use these to pull out colors etc.
		// NOTE: We can force force a light theme here because we don't want export
		const fakeContainerEl = document.createElement('div')
		fakeContainerEl.className = `tl-container tl-theme__${
			darkMode ? 'dark' : 'light'
		} tl-theme__force-sRGB`
		document.body.appendChild(fakeContainerEl)

		const containerStyle = getComputedStyle(fakeContainerEl)
		const fontsUsedInExport = new Map<string, string>()

		const colors: TLExportColors = {
			fill: Object.fromEntries(
				STYLES.color.map((color) => [
					color.id,
					containerStyle.getPropertyValue(`--palette-${color.id}`),
				])
			) as Record<TLColorType, string>,
			pattern: Object.fromEntries(
				STYLES.color.map((color) => [
					color.id,
					containerStyle.getPropertyValue(`--palette-${color.id}-pattern`),
				])
			) as Record<TLColorType, string>,
			semi: Object.fromEntries(
				STYLES.color.map((color) => [
					color.id,
					containerStyle.getPropertyValue(`--palette-${color.id}-semi`),
				])
			) as Record<TLColorType, string>,
			highlight: Object.fromEntries(
				STYLES.color.map((color) => [
					color.id,
					containerStyle.getPropertyValue(`--palette-${color.id}-highlight`),
				])
			) as Record<TLColorType, string>,
			text: containerStyle.getPropertyValue(`--color-text`),
			background: containerStyle.getPropertyValue(`--color-background`),
			solid: containerStyle.getPropertyValue(`--palette-solid`),
		}

		// Remove containerEl from DOM (temp DOM node)
		document.body.removeChild(fakeContainerEl)

		// ---Figure out which shapes we need to include
		const shapeIdsToInclude = this.getShapeAndDescendantIds(ids)
		const renderingShapes = this.computeUnorderedRenderingShapes([this.currentPageId]).filter(
			({ id }) => shapeIdsToInclude.has(id)
		)

		// --- Common bounding box of all shapes
		let bbox = null
		for (const { maskedPageBounds } of renderingShapes) {
			if (!maskedPageBounds) continue
			if (bbox) {
				bbox.union(maskedPageBounds)
			} else {
				bbox = maskedPageBounds.clone()
			}
		}

		// no unmasked shapes to export
		if (!bbox) return

		const singleFrameShapeId =
			ids.length === 1 && this.getShapeById(ids[0])?.type === 'frame' ? ids[0] : null
		if (!singleFrameShapeId) {
			// Expand by an extra 32 pixels
			bbox.expandBy(padding)
		}

		// We want the svg image to be BIGGER THAN USUAL to account for image quality
		const w = bbox.width * scale
		const h = bbox.height * scale

		// --- Create the SVG

		// Embed our custom fonts
		const svg = window.document.createElementNS('http://www.w3.org/2000/svg', 'svg')

		if (preserveAspectRatio) {
			svg.setAttribute('preserveAspectRatio', preserveAspectRatio)
		}

		svg.setAttribute('direction', 'ltr')
		svg.setAttribute('width', w + '')
		svg.setAttribute('height', h + '')
		svg.setAttribute('viewBox', `${bbox.minX} ${bbox.minY} ${bbox.width} ${bbox.height}`)
		svg.setAttribute('stroke-linecap', 'round')
		svg.setAttribute('stroke-linejoin', 'round')
		// Add current background color, or else background will be transparent

		if (background) {
			if (singleFrameShapeId) {
				svg.style.setProperty('background', colors.solid)
			} else {
				svg.style.setProperty('background-color', colors.background)
			}
		} else {
			svg.style.setProperty('background-color', 'transparent')
		}

		// Add the defs to the svg
		const defs = window.document.createElementNS('http://www.w3.org/2000/svg', 'defs')

		for (const element of Array.from(exportPatternSvgDefs(colors.solid))) {
			defs.appendChild(element)
		}

		try {
			document.body.focus?.() // weird but necessary
		} catch (e) {
			// not implemented
		}

		svg.append(defs)

		const unorderedShapeElements = (
			await Promise.all(
				renderingShapes.map(async ({ id, opacity, index, backgroundIndex }) => {
					// Don't render the frame if we're only exporting a single frame
					if (id === singleFrameShapeId) return []

					const shape = this.getShapeById(id)!
					const util = this.getShapeUtil(shape)

					let font: string | undefined
					if ('font' in shape.props) {
						if (shape.props.font) {
							if (fontsUsedInExport.has(shape.props.font)) {
								font = fontsUsedInExport.get(shape.props.font)!
							} else {
								// For some reason these styles aren't present in the fake element
								// so we need to get them from the real element
								font = realContainerStyle.getPropertyValue(`--tl-font-${shape.props.font}`)
								fontsUsedInExport.set(shape.props.font, font)
							}
						}
					}

					let shapeSvgElement = await util.toSvg?.(shape, font, colors)
					let backgroundSvgElement = await util.toBackgroundSvg?.(shape, font, colors)

					// wrap the shapes in groups so we can apply properties without overwriting ones from the shape util
					if (shapeSvgElement) {
						const outerElement = document.createElementNS('http://www.w3.org/2000/svg', 'g')
						outerElement.appendChild(shapeSvgElement)
						shapeSvgElement = outerElement
					}
					if (backgroundSvgElement) {
						const outerElement = document.createElementNS('http://www.w3.org/2000/svg', 'g')
						outerElement.appendChild(backgroundSvgElement)
						backgroundSvgElement = outerElement
					}

					if (!shapeSvgElement && !backgroundSvgElement) {
						const bounds = this.getPageBounds(shape)!
						const elm = window.document.createElementNS('http://www.w3.org/2000/svg', 'rect')
						elm.setAttribute('width', bounds.width + '')
						elm.setAttribute('height', bounds.height + '')
						elm.setAttribute('fill', colors.solid)
						elm.setAttribute('stroke', colors.pattern.grey)
						elm.setAttribute('stroke-width', '1')
						shapeSvgElement = elm
					}

					let pageTransform = this.getPageTransform(shape)!.toCssString()
					if ('scale' in shape.props) {
						if (shape.props.scale !== 1) {
							pageTransform = `${pageTransform} scale(${shape.props.scale}, ${shape.props.scale})`
						}
					}

					shapeSvgElement?.setAttribute('transform', pageTransform)
					backgroundSvgElement?.setAttribute('transform', pageTransform)
					shapeSvgElement?.setAttribute('opacity', opacity + '')
					backgroundSvgElement?.setAttribute('opacity', opacity + '')

					// Create svg mask if shape has a frame as parent
					const pageMask = this.getPageMaskById(shape.id)
					if (pageMask) {
						// Create a clip path and add it to defs
						const clipPathEl = document.createElementNS('http://www.w3.org/2000/svg', 'clipPath')
						defs.appendChild(clipPathEl)
						const id = nanoid()
						clipPathEl.id = id

						// Create a polyline mask that does the clipping
						const mask = document.createElementNS('http://www.w3.org/2000/svg', 'path')
						mask.setAttribute('d', `M${pageMask.map(({ x, y }) => `${x},${y}`).join('L')}Z`)
						clipPathEl.appendChild(mask)

						// Create group that uses the clip path and wraps the shape elements
						if (shapeSvgElement) {
							const outerElement = document.createElementNS('http://www.w3.org/2000/svg', 'g')
							outerElement.setAttribute('clip-path', `url(#${id})`)
							outerElement.appendChild(shapeSvgElement)
							shapeSvgElement = outerElement
						}

						if (backgroundSvgElement) {
							const outerElement = document.createElementNS('http://www.w3.org/2000/svg', 'g')
							outerElement.setAttribute('clip-path', `url(#${id})`)
							outerElement.appendChild(backgroundSvgElement)
							backgroundSvgElement = outerElement
						}
					}

					const elements = []
					if (shapeSvgElement) {
						elements.push({ zIndex: index, element: shapeSvgElement })
					}
					if (backgroundSvgElement) {
						elements.push({ zIndex: backgroundIndex, element: backgroundSvgElement })
					}

					return elements
				})
			)
		).flat()

		for (const { element } of unorderedShapeElements.sort((a, b) => a.zIndex - b.zIndex)) {
			svg.appendChild(element)
		}

		// Add styles to the defs
		let styles = ``
		const style = window.document.createElementNS('http://www.w3.org/2000/svg', 'style')

		// Insert fonts into app
		const fontInstances: FontFace[] = []

		if ('fonts' in document) {
			document.fonts.forEach((font) => fontInstances.push(font))
		}

		await Promise.all(
			fontInstances.map(async (font) => {
				const fileReader = new FileReader()

				let isUsed = false

				fontsUsedInExport.forEach((fontName) => {
					if (fontName.includes(font.family)) {
						isUsed = true
					}
				})

				if (!isUsed) return

				const url = (font as any).$$_url

				const fontFaceRule = (font as any).$$_fontface

				if (url) {
					const fontFile = await (await fetch(url)).blob()

					const base64Font = await new Promise<string>((resolve, reject) => {
						fileReader.onload = () => resolve(fileReader.result as string)
						fileReader.onerror = () => reject(fileReader.error)
						fileReader.readAsDataURL(fontFile)
					})

					const newFontFaceRule = '\n' + fontFaceRule.replaceAll(url, base64Font)
					styles += newFontFaceRule
				}
			})
		)

		style.textContent = styles

		defs.append(style)

		return svg
	}

	/**
	 * Rename a page.
	 *
	 * @example
	 * ```ts
	 * editor.renamePage('page1', 'My Page')
	 * ```
	 *
	 * @param id - The id of the page to rename.
	 * @param name - The new name.
	 *
	 * @public
	 */
	renamePage(id: TLPageId, name: string, squashing = false) {
		if (this.isReadOnly) return this
		this.updatePage({ id, name }, squashing)
		return this
	}

	/**
	 * Move shapes to page.
	 *
	 * @example
	 * ```ts
	 * editor.moveShapesToPage(['box1', 'box2'], 'page1')
	 * ```
	 *
	 * @param ids - The ids of the shapes to move.
	 * @param pageId - The id of the page where the shapes will be moved.
	 *
	 * @public
	 */
	moveShapesToPage(ids: TLShapeId[], pageId: TLPageId): this {
		if (ids.length === 0) return this
		if (this.isReadOnly) return this

		const { currentPageId } = this

		if (pageId === currentPageId) return this
		if (!this.store.has(pageId)) return this

		// Basically copy the shapes
		const content = this.getContent(ids)

		// Just to be sure
		if (!content) return this

		// If there is no space on pageId, or if the selected shapes
		// would take the new page above the limit, don't move the shapes
		if (this.getShapeIdsInPage(pageId).size + content.shapes.length > MAX_SHAPES_PER_PAGE) {
			alertMaxShapes(this, pageId)
			return this
		}

		const fromPageZ = this.camera.z

		this.history.batch(() => {
			// Delete the shapes on the current page
			this.deleteShapes(ids)

			// Move to the next page
			this.setCurrentPageId(pageId)

			// Put the shape content onto the new page; parents and indices will
			// be taken care of by the putContent method; make sure to pop any focus
			// layers so that the content will be put onto the page.
			this.setFocusLayer(null)
			this.selectNone()
			this.putContent(content, { select: true, preserveIds: true, preservePosition: true })

			// Force the new page's camera to be at the same zoom level as the
			// "from" page's camera, then center the "to" page's camera on the
			// pasted shapes
			const {
				center: { x, y },
			} = this.selectionBounds!
			this.setCamera(this.camera.x, this.camera.y, fromPageZ)
			this.centerOnPoint(x, y)
		})

		return this
	}

	/**
	 * Toggle the lock state of one or more shapes. If there is a mix of locked and unlocked shapes, all shapes will be locked.
	 *
	 * @param ids - The ids of the shapes to toggle. Defaults to selected shapes.
	 *
	 * @public
	 */
	toggleLock(ids: TLShapeId[] = this.selectedIds): this {
		if (this.isReadOnly || ids.length === 0) return this

		let allLocked = true,
			allUnlocked = true
		const shapes: TLShape[] = []
		for (const id of ids) {
			const shape = this.getShapeById(id)
			if (shape) {
				shapes.push(shape)
				if (shape.isLocked) {
					allUnlocked = false
				} else {
					allLocked = false
				}
			}
		}
		if (allUnlocked) {
			this.updateShapes(shapes.map((shape) => ({ id: shape.id, type: shape.type, isLocked: true })))
			this.setSelectedIds([])
		} else if (allLocked) {
			this.updateShapes(
				shapes.map((shape) => ({ id: shape.id, type: shape.type, isLocked: false }))
			)
		} else {
			this.updateShapes(shapes.map((shape) => ({ id: shape.id, type: shape.type, isLocked: true })))
		}

		return this
	}

	/**
	 * Reorder shapes.
	 *
	 * @param operation - The operation to perform.
	 * @param ids - The ids to reorder.
	 *
	 * @public
	 */
	reorderShapes(operation: 'toBack' | 'toFront' | 'forward' | 'backward', ids: TLShapeId[]) {
		if (this.isReadOnly) return this
		if (ids.length === 0) return this
		// this.emit('reorder-shapes', { pageId: this.currentPageId, ids, operation })

		const parents = this.getParentsMappedToChildren(ids)

		const changes: TLShapePartial[] = []

		switch (operation) {
			case 'toBack': {
				parents.forEach((movingSet, parentId) => {
					const siblings = compact(
						this.getSortedChildIds(parentId).map((id) => this.getShapeById(id))
					)

					if (movingSet.size === siblings.length) return

					let below: string | undefined
					let above: string | undefined

					for (const shape of siblings) {
						if (!movingSet.has(shape)) {
							above = shape.index
							break
						}
						movingSet.delete(shape)
						below = shape.index
					}

					if (movingSet.size === 0) return

					const indices = getIndicesBetween(below, above, movingSet.size)

					Array.from(movingSet.values())
						.sort(sortByIndex)
						.forEach((node, i) =>
							changes.push({ id: node.id as any, type: node.type, index: indices[i] })
						)
				})

				break
			}
			case 'toFront': {
				parents.forEach((movingSet, parentId) => {
					const siblings = compact(
						this.getSortedChildIds(parentId).map((id) => this.getShapeById(id))
					)
					const len = siblings.length

					if (movingSet.size === len) return

					let below: string | undefined
					let above: string | undefined

					for (let i = len - 1; i > -1; i--) {
						const shape = siblings[i]

						if (!movingSet.has(shape)) {
							below = shape.index
							break
						}

						movingSet.delete(shape)
						above = shape.index
					}

					if (movingSet.size === 0) return

					const indices = getIndicesBetween(below, above, movingSet.size)

					Array.from(movingSet.values())
						.sort(sortByIndex)
						.forEach((node, i) =>
							changes.push({ id: node.id as any, type: node.type, index: indices[i] })
						)
				})

				break
			}
			case 'forward': {
				parents.forEach((movingSet, parentId) => {
					const siblings = compact(
						this.getSortedChildIds(parentId).map((id) => this.getShapeById(id))
					)
					const len = siblings.length

					if (movingSet.size === len) return

					const movingIndices = new Set(Array.from(movingSet).map((n) => siblings.indexOf(n)))

					let selectIndex = -1
					let isSelecting = false
					let below: string | undefined
					let above: string | undefined
					let count: number

					for (let i = 0; i < len; i++) {
						const isMoving = movingIndices.has(i)

						if (!isSelecting && isMoving) {
							isSelecting = true
							selectIndex = i
							above = undefined
						} else if (isSelecting && !isMoving) {
							isSelecting = false
							count = i - selectIndex
							below = siblings[i].index
							above = siblings[i + 1]?.index

							const indices = getIndicesBetween(below, above, count)

							for (let k = 0; k < count; k++) {
								const node = siblings[selectIndex + k]
								changes.push({ id: node.id as any, type: node.type, index: indices[k] })
							}
						}
					}
				})

				break
			}
			case 'backward': {
				parents.forEach((movingSet, parentId) => {
					const siblings = compact(
						this.getSortedChildIds(parentId).map((id) => this.getShapeById(id))
					)
					const len = siblings.length

					if (movingSet.size === len) return

					const movingIndices = new Set(Array.from(movingSet).map((n) => siblings.indexOf(n)))

					let selectIndex = -1
					let isSelecting = false
					let count: number

					for (let i = len - 1; i > -1; i--) {
						const isMoving = movingIndices.has(i)

						if (!isSelecting && isMoving) {
							isSelecting = true
							selectIndex = i
						} else if (isSelecting && !isMoving) {
							isSelecting = false
							count = selectIndex - i

							const indices = getIndicesBetween(siblings[i - 1]?.index, siblings[i].index, count)

							for (let k = 0; k < count; k++) {
								const node = siblings[i + k + 1]
								changes.push({ id: node.id as any, type: node.type, index: indices[k] })
							}
						}
					}
				})

				break
			}
		}

		this.updateShapes(changes)
		return this
	}

	/**
	 * Send shapes to the back of the page's object list.
	 *
	 * @example
	 * ```ts
	 * editor.sendToBack()
	 * editor.sendToBack(['id1', 'id2'])
	 * ```
	 *
	 * @param ids - The ids of the shapes to move. Defaults to the ids of the selected shapes.
	 *
	 * @public
	 */
	sendToBack(ids = this.pageState.selectedIds) {
		this.reorderShapes('toBack', ids)
		return this
	}

	/**
	 * Send shapes backward in the page's object list.
	 *
	 * @example
	 * ```ts
	 * editor.sendBackward()
	 * editor.sendBackward(['id1', 'id2'])
	 * ```
	 *
	 * @param ids - The ids of the shapes to move. Defaults to the ids of the selected shapes.
	 *
	 * @public
	 */
	sendBackward(ids = this.pageState.selectedIds) {
		this.reorderShapes('backward', ids)
		return this
	}

	/**
	 * Bring shapes forward in the page's object list.
	 *
	 * @example
	 * ```ts
	 * editor.bringForward()
	 * editor.bringForward(['id1', 'id2'])
	 * ```
	 *
	 * @param ids - The ids of the shapes to move. Defaults to the ids of the selected shapes.
	 *
	 * @public
	 */
	bringForward(ids = this.pageState.selectedIds) {
		this.reorderShapes('forward', ids)
		return this
	}

	/**
	 * Bring shapes to the front of the page's object list.
	 *
	 * @example
	 * ```ts
	 * editor.bringToFront()
	 * editor.bringToFront(['id1', 'id2'])
	 * ```
	 *
	 * @param ids - The ids of the shapes to move. Defaults to the ids of the selected shapes.
	 *
	 * @public
	 */
	bringToFront(ids = this.pageState.selectedIds) {
		this.reorderShapes('toFront', ids)
		return this
	}

	/**
	 * Flip shape positions.
	 *
	 * @example
	 * ```ts
	 * editor.flipShapes('horizontal')
	 * editor.flipShapes('horizontal', ['box1', 'box2'])
	 * ```
	 *
	 * @param operation - Whether to flip horizontally or vertically.
	 * @param ids - The ids of the shapes to flip. Defaults to selected shapes.
	 *
	 * @public
	 */
	flipShapes(operation: 'horizontal' | 'vertical', ids: TLShapeId[] = this.selectedIds) {
		if (this.isReadOnly) return this

		let shapes = compact(ids.map((id) => this.getShapeById(id)))

		if (!shapes.length) return this

		shapes = compact(
			shapes
				.map((shape) => {
					if (shape.type === 'group') {
						return this.getSortedChildIds(shape.id).map((id) => this.getShapeById(id))
					}

					return shape
				})
				.flat()
		)

		const scaleOriginPage = Box2d.Common(compact(shapes.map((id) => this.getPageBounds(id)))).center

		this.batch(() => {
			for (const shape of shapes) {
				const util = this.getShapeUtil(shape)
				const bounds = util.bounds(shape)
				const initialPageTransform = this.getPageTransformById(shape.id)
				if (!initialPageTransform) continue
				this.resizeShape(
					shape.id,
					{ x: operation === 'horizontal' ? -1 : 1, y: operation === 'vertical' ? -1 : 1 },
					{
						initialBounds: bounds,
						initialPageTransform,
						initialShape: shape,
						mode: 'scale_shape',
						scaleOrigin: scaleOriginPage,
						scaleAxisRotation: 0,
					}
				)
			}
		})

		return this
	}

	/**
	 * Stack shape.
	 *
	 * @example
	 * ```ts
	 * editor.stackShapes('horizontal')
	 * editor.stackShapes('horizontal', ['box1', 'box2'])
	 * editor.stackShapes('horizontal', ['box1', 'box2'], 20)
	 * ```
	 *
	 * @param operation - Whether to stack horizontally or vertically.
	 * @param ids - The ids of the shapes to stack. Defaults to selected shapes.
	 * @param gap - A specific gap to use when stacking.
	 *
	 * @public
	 */
	stackShapes(
		operation: 'horizontal' | 'vertical',
		ids: TLShapeId[] = this.pageState.selectedIds,
		gap?: number
	) {
		if (this.isReadOnly) return this

		const shapes = compact(ids.map((id) => this.getShapeById(id))).filter((shape) => {
			if (!shape) return false

			if (this.isShapeOfType(shape, ArrowShapeUtil)) {
				if (shape.props.start.type === 'binding' || shape.props.end.type === 'binding') {
					return false
				}
			}

			return true
		})

		const len = shapes.length

		if ((gap === undefined && len < 3) || len < 2) return this

		const pageBounds = Object.fromEntries(
			shapes.map((shape) => [shape.id, this.getPageBounds(shape)!])
		)

		let val: 'x' | 'y'
		let min: 'minX' | 'minY'
		let max: 'maxX' | 'maxY'
		let dim: 'width' | 'height'

		if (operation === 'horizontal') {
			val = 'x'
			min = 'minX'
			max = 'maxX'
			dim = 'width'
		} else {
			val = 'y'
			min = 'minY'
			max = 'maxY'
			dim = 'height'
		}

		let shapeGap: number

		if (gap === undefined) {
			const gaps: { gap: number; count: number }[] = []

			shapes.sort((a, b) => pageBounds[a.id][min] - pageBounds[b.id][min])

			// Collect all of the gaps between shapes. We want to find
			// patterns (equal gaps between shapes) and use the most common
			// one as the gap for all of the shapes.
			for (let i = 0; i < len - 1; i++) {
				const shape = shapes[i]
				const nextShape = shapes[i + 1]

				const bounds = pageBounds[shape.id]
				const nextBounds = pageBounds[nextShape.id]

				const gap = nextBounds[min] - bounds[max]

				const current = gaps.find((g) => g.gap === gap)

				if (current) {
					current.count++
				} else {
					gaps.push({ gap, count: 1 })
				}
			}

			// Which gap is the most common?
			let maxCount = 0
			gaps.forEach((g) => {
				if (g.count > maxCount) {
					maxCount = g.count
					shapeGap = g.gap
				}
			})

			// If there is no most-common gap, use the average gap.
			if (maxCount === 1) {
				shapeGap = Math.max(0, gaps.reduce((a, c) => a + c.gap * c.count, 0) / (len - 1))
			}
		} else {
			// If a gap was provided, then use that instead.
			shapeGap = gap
		}

		const changes: TLShapePartial[] = []

		let v = pageBounds[shapes[0].id][max]

		shapes.forEach((shape, i) => {
			if (i === 0) return

			const delta = { x: 0, y: 0 }
			delta[val] = v + shapeGap - pageBounds[shape.id][val]

			const parent = this.getParentShape(shape)
			const localDelta = parent ? Vec2d.Rot(delta, -this.getPageRotation(parent)) : delta

			const translateStartChanges = this.getShapeUtil(shape).onTranslateStart?.(shape)

			changes.push(
				translateStartChanges
					? {
							...translateStartChanges,
							[val]: shape[val] + localDelta[val],
					  }
					: {
							id: shape.id as any,
							type: shape.type,
							[val]: shape[val] + localDelta[val],
					  }
			)

			v += pageBounds[shape.id][dim] + shapeGap
		})

		this.updateShapes(changes)
		return this
	}

	/**
	 * Pack shapes into a grid centered on their current position. Based on potpack
	 * (https://github.com/mapbox/potpack)
	 * @param ids - The ids of the shapes to pack. Defaults to selected shapes.
	 * @param padding - The padding to apply to the packed shapes.
	 */
	packShapes(ids: TLShapeId[] = this.pageState.selectedIds, padding = 16) {
		if (this.isReadOnly) return this
		if (ids.length < 2) return this

		const shapes = compact(
			ids
				.map((id) => this.getShapeById(id))
				.filter((shape) => {
					if (!shape) return false

					if (this.isShapeOfType(shape, ArrowShapeUtil)) {
						if (shape.props.start.type === 'binding' || shape.props.end.type === 'binding') {
							return false
						}
					}

					return true
				})
		)
		const shapePageBounds: Record<string, Box2d> = {}
		const nextShapePageBounds: Record<string, Box2d> = {}

		let shape: TLShape,
			bounds: Box2d,
			area = 0

		for (let i = 0; i < shapes.length; i++) {
			shape = shapes[i]
			bounds = this.getPageBounds(shape)!
			shapePageBounds[shape.id] = bounds
			nextShapePageBounds[shape.id] = bounds.clone()
			area += bounds.width * bounds.height
		}

		const commonBounds = Box2d.Common(compact(Object.values(shapePageBounds)))

		const maxWidth = commonBounds.width

		// sort the shapes by height, descending
		shapes.sort((a, b) => shapePageBounds[b.id].height - shapePageBounds[a.id].height)

		// Start with is (sort of) the square of the area
		const startWidth = Math.max(Math.ceil(Math.sqrt(area / 0.95)), maxWidth)

		// first shape fills the width and is infinitely tall
		const spaces: Box2d[] = [new Box2d(commonBounds.x, commonBounds.y, startWidth, Infinity)]

		let width = 0
		let height = 0
		let space: Box2d
		let last: Box2d

		for (let i = 0; i < shapes.length; i++) {
			shape = shapes[i]
			bounds = nextShapePageBounds[shape.id]

			// starting at the back (smaller shapes)
			for (let i = spaces.length - 1; i >= 0; i--) {
				space = spaces[i]

				// find a space that is big enough to contain the shape
				if (bounds.width > space.width || bounds.height > space.height) continue

				// add the shape to its top-left corner
				bounds.x = space.x
				bounds.y = space.y

				height = Math.max(height, bounds.maxY)
				width = Math.max(width, bounds.maxX)

				if (bounds.width === space.width && bounds.height === space.height) {
					// remove the space on a perfect fit
					last = spaces.pop()!
					if (i < spaces.length) spaces[i] = last
				} else if (bounds.height === space.height) {
					// fit the shape into the space (width)
					space.x += bounds.width + padding
					space.width -= bounds.width + padding
				} else if (bounds.width === space.width) {
					// fit the shape into the space (height)
					space.y += bounds.height + padding
					space.height -= bounds.height + padding
				} else {
					// split the space into two spaces
					spaces.push(
						new Box2d(
							space.x + (bounds.width + padding),
							space.y,
							space.width - (bounds.width + padding),
							bounds.height
						)
					)
					space.y += bounds.height + padding
					space.height -= bounds.height + padding
				}
				break
			}
		}

		const commonAfter = Box2d.Common(Object.values(nextShapePageBounds))
		const centerDelta = Vec2d.Sub(commonBounds.center, commonAfter.center)

		let nextBounds: Box2d

		const changes: TLShapePartial<any>[] = []

		for (let i = 0; i < shapes.length; i++) {
			shape = shapes[i]
			bounds = shapePageBounds[shape.id]
			nextBounds = nextShapePageBounds[shape.id]

			const delta = this.getDeltaInParentSpace(
				shape,
				Vec2d.Sub(nextBounds.point, bounds.point).add(centerDelta)
			)

			const change: TLShapePartial = {
				id: shape.id,
				type: shape.type,
				x: shape.x + delta.x,
				y: shape.y + delta.y,
			}

			const translateStartChange = this.getShapeUtil(shape).onTranslateStart?.({
				...shape,
				...change,
			})

			if (translateStartChange) {
				changes.push({ ...change, ...translateStartChange })
			} else {
				changes.push(change)
			}
		}

		if (changes.length) {
			this.updateShapes(changes)
		}

		return this
	}

	/**
	 * Align shape positions.
	 *
	 * @example
	 * ```ts
	 * editor.alignShapes('left')
	 * editor.alignShapes('left', ['box1', 'box2'])
	 * ```
	 *
	 * @param operation - The align operation to apply.
	 * @param ids - The ids of the shapes to align. Defaults to selected shapes.
	 *
	 * @public
	 */
	alignShapes(
		operation: 'left' | 'center-horizontal' | 'right' | 'top' | 'center-vertical' | 'bottom',
		ids: TLShapeId[] = this.pageState.selectedIds
	) {
		if (this.isReadOnly) return this
		if (ids.length < 2) return this

		const shapes = compact(ids.map((id) => this.getShapeById(id)))
		const shapePageBounds = Object.fromEntries(
			shapes.map((shape) => [shape.id, this.getPageBounds(shape)])
		)
		const commonBounds = Box2d.Common(compact(Object.values(shapePageBounds)))

		const changes: TLShapePartial[] = []

		shapes.forEach((shape) => {
			const pageBounds = shapePageBounds[shape.id]
			if (!pageBounds) return

			const delta = { x: 0, y: 0 }

			switch (operation) {
				case 'top': {
					delta.y = commonBounds.minY - pageBounds.minY
					break
				}
				case 'center-vertical': {
					delta.y = commonBounds.midY - pageBounds.minY - pageBounds.height / 2
					break
				}
				case 'bottom': {
					delta.y = commonBounds.maxY - pageBounds.minY - pageBounds.height
					break
				}
				case 'left': {
					delta.x = commonBounds.minX - pageBounds.minX
					break
				}
				case 'center-horizontal': {
					delta.x = commonBounds.midX - pageBounds.minX - pageBounds.width / 2
					break
				}
				case 'right': {
					delta.x = commonBounds.maxX - pageBounds.minX - pageBounds.width
					break
				}
			}

			const parent = this.getParentShape(shape)
			const localDelta = parent ? Vec2d.Rot(delta, -this.getPageRotation(parent)) : delta

			const translateChanges = this.getShapeUtil(shape).onTranslateStart?.(shape)

			changes.push(
				translateChanges
					? {
							...translateChanges,
							x: shape.x + localDelta.x,
							y: shape.y + localDelta.y,
					  }
					: {
							id: shape.id,
							type: shape.type,
							x: shape.x + localDelta.x,
							y: shape.y + localDelta.y,
					  }
			)
		})

		this.updateShapes(changes)
		return this
	}

	/**
	 * Distribute shape positions.
	 *
	 * @example
	 * ```ts
	 * editor.distributeShapes('left')
	 * editor.distributeShapes('left', ['box1', 'box2'])
	 * ```
	 *
	 * @param operation - Whether to distribute shapes horizontally or vertically.
	 * @param ids - The ids of the shapes to distribute. Defaults to selected shapes.
	 *
	 * @public
	 */
	distributeShapes(
		operation: 'horizontal' | 'vertical',
		ids: TLShapeId[] = this.pageState.selectedIds
	) {
		if (this.isReadOnly) return this
		if (ids.length < 3) return this

		const len = ids.length
		const shapes = compact(ids.map((id) => this.getShapeById(id)))
		const pageBounds = Object.fromEntries(
			shapes.map((shape) => [shape.id, this.getPageBounds(shape)!])
		)

		let val: 'x' | 'y'
		let min: 'minX' | 'minY'
		let max: 'maxX' | 'maxY'
		let mid: 'midX' | 'midY'
		let dim: 'width' | 'height'

		if (operation === 'horizontal') {
			val = 'x'
			min = 'minX'
			max = 'maxX'
			mid = 'midX'
			dim = 'width'
		} else {
			val = 'y'
			min = 'minY'
			max = 'maxY'
			mid = 'midY'
			dim = 'height'
		}
		const changes: TLShapePartial[] = []

		// Clustered
		const first = shapes.sort((a, b) => pageBounds[a.id][min] - pageBounds[b.id][min])[0]
		const last = shapes.sort((a, b) => pageBounds[b.id][max] - pageBounds[a.id][max])[0]

		const midFirst = pageBounds[first.id][mid]
		const step = (pageBounds[last.id][mid] - midFirst) / (len - 1)
		const v = midFirst + step

		shapes
			.filter((shape) => shape !== first && shape !== last)
			.sort((a, b) => pageBounds[a.id][mid] - pageBounds[b.id][mid])
			.forEach((shape, i) => {
				const delta = { x: 0, y: 0 }
				delta[val] = v + step * i - pageBounds[shape.id][dim] / 2 - pageBounds[shape.id][val]

				const parent = this.getParentShape(shape)
				const localDelta = parent ? Vec2d.Rot(delta, -this.getPageRotation(parent)) : delta
				const translateStartChanges = this.getShapeUtil(shape).onTranslateStart?.(shape)

				changes.push(
					translateStartChanges
						? {
								...translateStartChanges,
								[val]: shape[val] + localDelta[val],
						  }
						: {
								id: shape.id,
								type: shape.type,
								[val]: shape[val] + localDelta[val],
						  }
				)
			})

		this.updateShapes(changes)
		return this
	}

	/** @internal */
	private _resizeUnalignedShape(
		id: TLShapeId,
		scale: VecLike,
		options: {
			initialBounds: Box2d
			scaleOrigin: VecLike
			scaleAxisRotation: number
			initialShape: TLShape
			initialPageTransform: MatLike
		}
	) {
		const { type } = options.initialShape
		// If a shape is not aligned with the scale axis we need to treat it differently to avoid skewing.
		// Instead of skewing we normalize the scale aspect ratio (i.e. keep the same scale magnitude in both axes)
		// and then after applying the scale to the shape we also rotate it if required and translate it so that it's center
		// point ends up in the right place.

		const shapeScale = new Vec2d(scale.x, scale.y)

		// // make sure we are constraining aspect ratio, and using the smallest scale axis to avoid shapes getting bigger
		// // than the selection bounding box
		if (Math.abs(scale.x) > Math.abs(scale.y)) {
			shapeScale.x = Math.sign(scale.x) * Math.abs(scale.y)
		} else {
			shapeScale.y = Math.sign(scale.y) * Math.abs(scale.x)
		}

		// first we can scale the shape about its center point
		this.resizeShape(id, shapeScale, {
			initialShape: options.initialShape,
			initialBounds: options.initialBounds,
		})

		// then if the shape is flipped in one axis only, we need to apply an extra rotation
		// to make sure the shape is mirrored correctly
		if (Math.sign(scale.x) * Math.sign(scale.y) < 0) {
			let { rotation } = Matrix2d.Decompose(options.initialPageTransform)
			rotation -= 2 * rotation
			this.updateShapes([{ id, type, rotation }], true)
		}

		// Next we need to translate the shape so that it's center point ends up in the right place.
		// To do that we first need to calculate the center point of the shape in page space before the scale was applied.
		const preScaleShapePageCenter = Matrix2d.applyToPoint(
			options.initialPageTransform,
			options.initialBounds.center
		)

		// And now we scale the center point by the original scale factor
		const postScaleShapePageCenter = this._scalePagePoint(
			preScaleShapePageCenter,
			options.scaleOrigin,
			scale,
			options.scaleAxisRotation
		)

		// now calculate how far away the shape is from where it needs to be
		const currentPageCenter = this.getPageCenterById(id)
		const currentPagePoint = this.getPagePointById(id)
		if (!currentPageCenter || !currentPagePoint) return this
		const pageDelta = Vec2d.Sub(postScaleShapePageCenter, currentPageCenter)

		// and finally figure out what the shape's new position should be
		const postScaleShapePagePoint = Vec2d.Add(currentPagePoint, pageDelta)
		const { x, y } = this.getPointInParentSpace(id, postScaleShapePagePoint)

		this.updateShapes([{ id, type, x, y }], true)

		return this
	}

	/** @internal */
	private _scalePagePoint(
		point: VecLike,
		scaleOrigin: VecLike,
		scale: VecLike,
		scaleAxisRotation: number
	) {
		const relativePoint = Vec2d.RotWith(point, scaleOrigin, -scaleAxisRotation).sub(scaleOrigin)

		// calculate the new point position relative to the scale origin
		const newRelativePagePoint = Vec2d.MulV(relativePoint, scale)

		// and rotate it back to page coords to get the new page point of the resized shape
		const destination = Vec2d.Add(newRelativePagePoint, scaleOrigin).rotWith(
			scaleOrigin,
			scaleAxisRotation
		)

		return destination
	}

	/**
	 * Resize a shape.
	 *
	 * @param id - The id of the shape to resize.
	 * @param scale - The scale factor to apply to the shape.
	 * @param options - Additional options.
	 *
	 * @public
	 */
	resizeShape(
		id: TLShapeId,
		scale: VecLike,
		options: {
			initialBounds?: Box2d
			scaleOrigin?: VecLike
			scaleAxisRotation?: number
			initialShape?: TLShape
			initialPageTransform?: MatLike
			dragHandle?: TLResizeHandle
			mode?: TLResizeMode
		} = {}
	) {
		if (this.isReadOnly) return this

		if (!Number.isFinite(scale.x)) scale = new Vec2d(1, scale.y)
		if (!Number.isFinite(scale.y)) scale = new Vec2d(scale.x, 1)

		const initialShape = options.initialShape ?? this.getShapeById(id)
		if (!initialShape) return this

		const scaleOrigin = options.scaleOrigin ?? this.getPageBoundsById(id)?.center
		if (!scaleOrigin) return this

		const pageRotation = this.getPageRotationById(id)

		if (pageRotation == null) return this

		const scaleAxisRotation = options.scaleAxisRotation ?? pageRotation

		const pageTransform = options.initialPageTransform ?? this.getPageTransformById(id)
		if (!pageTransform) return this

		const initialBounds = options.initialBounds ?? this.getBoundsById(id)

		if (!initialBounds) return this

		if (!areAnglesCompatible(pageRotation, scaleAxisRotation)) {
			// shape is awkwardly rotated, keep the aspect ratio locked and adopt the scale factor
			// from whichever axis is being scaled the least, to avoid the shape getting bigger
			// than the bounds of the selection
			// const minScale = Math.min(Math.abs(scale.x), Math.abs(scale.y))
			return this._resizeUnalignedShape(id, scale, {
				...options,
				initialBounds,
				scaleOrigin,
				scaleAxisRotation,
				initialPageTransform: pageTransform,
				initialShape,
			})
		}

		const util = this.getShapeUtil(initialShape)

		if (util.isAspectRatioLocked(initialShape)) {
			if (Math.abs(scale.x) > Math.abs(scale.y)) {
				scale = new Vec2d(scale.x, Math.sign(scale.y) * Math.abs(scale.x))
			} else {
				scale = new Vec2d(Math.sign(scale.x) * Math.abs(scale.y), scale.y)
			}
		}

		if (util.onResize && util.canResize(initialShape)) {
			// get the model changes from the shape util
			const newPagePoint = this._scalePagePoint(
				Matrix2d.applyToPoint(pageTransform, new Vec2d(0, 0)),
				scaleOrigin,
				scale,
				scaleAxisRotation
			)

			const newLocalPoint = this.getPointInParentSpace(initialShape.id, newPagePoint)

			// resize the shape's local bounding box
			const myScale = new Vec2d(scale.x, scale.y)
			// the shape is aligned with the rest of the shapes in the selection, but may be
			// 90deg offset from the main rotation of the selection, in which case
			// we need to flip the width and height scale factors
			const areWidthAndHeightAlignedWithCorrectAxis = approximately(
				(pageRotation - scaleAxisRotation) % Math.PI,
				0
			)
			myScale.x = areWidthAndHeightAlignedWithCorrectAxis ? scale.x : scale.y
			myScale.y = areWidthAndHeightAlignedWithCorrectAxis ? scale.y : scale.x

			// adjust initial model for situations where the parent has moved during the resize
			// e.g. groups
			const initialPagePoint = Matrix2d.applyToPoint(pageTransform, new Vec2d())

			// need to adjust the shape's x and y points in case the parent has moved since start of resizing
			const { x, y } = this.getPointInParentSpace(initialShape.id, initialPagePoint)

			this.updateShapes(
				[
					{
						id,
						type: initialShape.type as any,
						x: newLocalPoint.x,
						y: newLocalPoint.y,
						...util.onResize(
							{ ...initialShape, x, y },
							{
								newPoint: newLocalPoint,
								handle: options.dragHandle ?? 'bottom_right',
								// don't set isSingle to true for children
								mode: options.mode ?? 'scale_shape',
								scaleX: myScale.x,
								scaleY: myScale.y,
								initialBounds,
								initialShape,
							}
						),
					},
				],
				true
			)
		} else {
			const initialPageCenter = Matrix2d.applyToPoint(pageTransform, initialBounds.center)
			// get the model changes from the shape util
			const newPageCenter = this._scalePagePoint(
				initialPageCenter,
				scaleOrigin,
				scale,
				scaleAxisRotation
			)

			const initialPageCenterInParentSpace = this.getPointInParentSpace(
				initialShape.id,
				initialPageCenter
			)
			const newPageCenterInParentSpace = this.getPointInParentSpace(initialShape.id, newPageCenter)

			const delta = Vec2d.Sub(newPageCenterInParentSpace, initialPageCenterInParentSpace)
			// apply the changes to the model
			this.updateShapes(
				[
					{
						id,
						type: initialShape.type as any,
						x: initialShape.x + delta.x,
						y: initialShape.y + delta.y,
					},
				],
				true
			)
		}

		return this
	}

	/**
	 * Stretch shape sizes and positions to fill their common bounding box.
	 *
	 * @example
	 * ```ts
	 * editor.stretchShapes('horizontal')
	 * editor.stretchShapes('horizontal', ['box1', 'box2'])
	 * ```
	 *
	 * @param operation - Whether to stretch shapes horizontally or vertically.
	 * @param ids - The ids of the shapes to stretch. Defaults to selected shapes.
	 *
	 * @public
	 */
	stretchShapes(
		operation: 'horizontal' | 'vertical',
		ids: TLShapeId[] = this.pageState.selectedIds
	) {
		if (this.isReadOnly) return this
		if (ids.length < 2) return this

		const shapes = compact(ids.map((id) => this.getShapeById(id)))
		const shapeBounds = Object.fromEntries(shapes.map((shape) => [shape.id, this.getBounds(shape)]))
		const shapePageBounds = Object.fromEntries(
			shapes.map((shape) => [shape.id, this.getPageBounds(shape)!])
		)
		const commonBounds = Box2d.Common(compact(Object.values(shapePageBounds)))

		const changes: TLShapePartial[] = []

		switch (operation) {
			case 'vertical': {
				this.batch(() => {
					for (const shape of shapes) {
						const pageRotation = this.getPageRotation(shape)
						if (pageRotation % PI2) continue
						const bounds = shapeBounds[shape.id]
						const pageBounds = shapePageBounds[shape.id]
						const localOffset = this.getDeltaInParentSpace(
							shape,
							new Vec2d(0, commonBounds.minY - pageBounds.minY)
						)
						const { x, y } = Vec2d.Add(localOffset, shape)
						this.updateShapes([{ id: shape.id, type: shape.type, x, y }], true)
						const scale = new Vec2d(1, commonBounds.height / pageBounds.height)
						this.resizeShape(shape.id, scale, {
							initialBounds: bounds,
							scaleOrigin: new Vec2d(pageBounds.center.x, commonBounds.minY),
							scaleAxisRotation: 0,
						})
					}
				})
				break
			}
			case 'horizontal': {
				this.batch(() => {
					for (const shape of shapes) {
						const bounds = shapeBounds[shape.id]
						const pageBounds = shapePageBounds[shape.id]
						const pageRotation = this.getPageRotation(shape)
						if (pageRotation % PI2) continue
						const localOffset = this.getDeltaInParentSpace(
							shape,
							new Vec2d(commonBounds.minX - pageBounds.minX, 0)
						)
						const { x, y } = Vec2d.Add(localOffset, shape)
						this.updateShapes([{ id: shape.id, type: shape.type, x, y }], true)
						const scale = new Vec2d(commonBounds.width / pageBounds.width, 1)
						this.resizeShape(shape.id, scale, {
							initialBounds: bounds,
							scaleOrigin: new Vec2d(commonBounds.minX, pageBounds.center.y),
							scaleAxisRotation: 0,
						})
					}
				})

				break
			}
		}

		this.updateShapes(changes)
		return this
	}

	/**
	 * Reparent shapes to a new parent. This operation preserves the shape's current page positions /
	 * rotations.
	 *
	 * @example
	 * ```ts
	 * editor.reparentShapesById(['box1', 'box2'], 'frame1')
	 * ```
	 *
	 * @param ids - The ids of the shapes to reparent.
	 * @param parentId - The id of the new parent shape.
	 * @param insertIndex - The index to insert the children.
	 *
	 * @public
	 */
	reparentShapesById(ids: TLShapeId[], parentId: TLParentId, insertIndex?: string) {
		const changes: TLShapePartial[] = []

		const parentTransform = isPageId(parentId)
			? Matrix2d.Identity()
			: this.getPageTransformById(parentId)!

		const parentPageRotation = parentTransform.decompose().rotation

		let indices: string[] = []

		const sibs = compact(this.getSortedChildIds(parentId).map((id) => this.getShapeById(id)))

		if (insertIndex) {
			const sibWithInsertIndex = sibs.find((s) => s.index === insertIndex)
			if (sibWithInsertIndex) {
				// If there's a sibling with the same index as the insert index...
				const sibAbove = sibs[sibs.indexOf(sibWithInsertIndex) + 1]
				if (sibAbove) {
					// If the sibling has a sibling above it, insert the shapes
					// between the sibling and its sibling above it.
					indices = getIndicesBetween(insertIndex, sibAbove.index, ids.length)
				} else {
					// Or if the sibling is the top sibling, insert the shapes
					// above the sibling
					indices = getIndicesAbove(insertIndex, ids.length)
				}
			} else {
				// If there's no collision, then we can start at the insert index
				const sibAbove = sibs.sort(sortByIndex).find((s) => s.index > insertIndex)

				if (sibAbove) {
					// If the siblings include a sibling with a higher index, insert the shapes
					// between the insert index and the sibling with the higher index.
					indices = getIndicesBetween(insertIndex, sibAbove.index, ids.length)
				} else {
					// Otherwise, we're at the top of the order, so insert the shapes above
					// the insert index.
					indices = getIndicesAbove(insertIndex, ids.length)
				}
			}
		} else {
			// If insert index is not specified, start the index at the top.
			const sib = sibs.length && sibs[sibs.length - 1]
			indices = sib ? getIndicesAbove(sib.index, ids.length) : getIndices(ids.length)
		}

		let id: TLShapeId
		for (let i = 0; i < ids.length; i++) {
			id = ids[i]
			const shape = this.getShapeById(id)
			const pagePoint = this.getPagePointById(id)

			if (!shape || !pagePoint) continue

			const newPoint = Matrix2d.applyToPoint(Matrix2d.Inverse(parentTransform), pagePoint)
			const newRotation = this.getPageRotation(shape) - parentPageRotation

			changes.push({
				id: shape.id,
				type: shape.type,
				parentId: parentId,
				x: newPoint.x,
				y: newPoint.y,
				rotation: newRotation,
				index: indices[i],
			})
		}

		this.updateShapes(changes)
		return this
	}

	/**
	 * Select one or more shapes.
	 *
	 * @example
	 * ```ts
	 * editor.select('id1')
	 * editor.select('id1', 'id2')
	 * ```
	 *
	 * @param ids - The ids to select.
	 *
	 * @public
	 */
	select(...ids: TLShapeId[]) {
		this.setSelectedIds(ids)
		return this
	}

	/**
	 * Remove a shape from the existing set of selected shapes.
	 *
	 * @example
	 * ```ts
	 * editor.deselect(shape.id)
	 * ```
	 *
	 * @public
	 */
	deselect(...ids: TLShapeId[]) {
		const { selectedIds } = this
		if (selectedIds.length > 0 && ids.length > 0) {
			this.setSelectedIds(selectedIds.filter((id) => !ids.includes(id)))
		}
		return this
	}

	/**
	 * Select all direct children of the current page.
	 *
	 * @example
	 * ```ts
	 * editor.selectAll()
	 * ```
	 *
	 * @public
	 */
	selectAll() {
		const ids = this.getSortedChildIds(this.currentPageId)
		// page might have no shapes
		if (ids.length <= 0) return this
		this.setSelectedIds(this._getUnlockedShapeIds(ids))

		return this
	}

	/**
	 * Get the shape ids of all descendants of the given shapes (including the shapes themselves).
	 *
	 * @param ids - The ids of the shapes to get descendants of.
	 *
	 * @returns The decscendant ids.
	 *
	 * @public
	 */
	getShapeAndDescendantIds(ids: TLShapeId[]): Set<TLShapeId> {
		const idsToInclude = new Set<TLShapeId>()

		const idsToCheck = [...ids]

		while (idsToCheck.length > 0) {
			const id = idsToCheck.pop()
			if (!id) break
			if (idsToInclude.has(id)) continue
			idsToInclude.add(id)
			this.getSortedChildIds(id).forEach((id) => {
				idsToCheck.push(id)
			})
		}

		return idsToInclude
	}

	/**
	 * Clear the selection.
	 *
	 * @example
	 * ```ts
	 * editor.selectNone()
	 * ```
	 *
	 * @public
	 */
	selectNone(): this {
		if (this.selectedIds.length > 0) {
			this.setSelectedIds([])
		}

		return this
	}

	/**
	 * Set the current page.
	 *
	 * @example
	 * ```ts
	 * editor.setCurrentPageId('page1')
	 * ```
	 *
	 * @param pageId - The id of the page to set as the current page.
	 * @param options - Options for setting the current page.
	 *
	 * @public
	 */
	setCurrentPageId(pageId: TLPageId, { stopFollowing = true }: TLViewportOptions = {}): this {
		this._setCurrentPageId(pageId, { stopFollowing })
		return this
	}

	/** @internal */
	private _setCurrentPageId = this.history.createCommand(
		'setCurrentPage',
		(pageId: TLPageId, { stopFollowing = true }: TLViewportOptions = {}) => {
			if (!this.store.has(pageId)) {
				console.error("Tried to set the current page id to a page that doesn't exist.")
				return
			}

			if (stopFollowing && this.instanceState.followingUserId) {
				this.stopFollowingUser()
			}

			return {
				data: { toId: pageId, fromId: this.currentPageId },
				squashing: true,
				preservesRedoStack: true,
			}
		},
		{
			do: ({ toId }) => {
				if (!this.store.has(toId)) {
					// in multiplayer contexts this page might have been deleted
					return
				}
				if (!this.getPageStateByPageId(toId)) {
					const camera = CameraRecordType.create({
						id: CameraRecordType.createId(toId),
					})
					this.store.put([
						camera,
						InstancePageStateRecordType.create({
							id: InstancePageStateRecordType.createId(toId),
							pageId: toId,
						}),
					])
				}

				this.store.put([{ ...this.instanceState, currentPageId: toId }])

				this.updateCullingBounds()
			},
			undo: ({ fromId }) => {
				if (!this.store.has(fromId)) {
					// in multiplayer contexts this page might have been deleted
					return
				}
				this.store.put([{ ...this.instanceState, currentPageId: fromId }])

				this.updateCullingBounds()
			},
			squash: ({ fromId }, { toId }) => {
				return { toId, fromId }
			},
		}
	)

	/**
	 * Update the instance's state.
	 *
	 * @param partial - A partial object to update the instance state with.
	 * @param ephemeral - Whether the change is ephemeral. Ephemeral changes don't get added to the undo/redo stack. Defaults to false.
	 * @param squashing - Whether the change will be squashed into the existing history entry rather than creating a new one. Defaults to false.
	 *
	 * @public
	 */
	updateInstanceState(
		partial: Partial<Omit<TLInstance, 'currentPageId'>>,
		ephemeral = false,
		squashing = false
	) {
		this._updateInstanceState(partial, ephemeral, squashing)
		return this
	}

	/** @internal */
	private _updateInstanceState = this.history.createCommand(
		'updateTabState',
		(partial: Partial<Omit<TLInstance, 'currentPageId'>>, ephemeral = false, squashing = false) => {
			const prev = this.instanceState
			const next = { ...prev, ...partial }

			return {
				data: { prev, next },
				squashing,
				ephemeral,
			}
		},
		{
			do: ({ next }) => {
				this.store.put([next])
			},
			undo: ({ prev }) => {
				this.store.put([prev])
			},
			squash({ prev }, { next }) {
				return { prev, next }
			},
		}
	)

	/**
	 * The current hovered shape id.
	 *
	 * @readonly
	 * @public
	 */
	@computed get hoveredId() {
		return this.pageState.hoveredId
	}

	/**
	 * The current hovered shape.
	 *
	 * @readonly
	 * @public
	 */
	@computed get hoveredShape() {
		if (!this.hoveredId) return null
		return this.getShapeById(this.hoveredId) ?? null
	}

	/**
	 * Set the current hovered shape.
	 *
	 * @example
	 * ```ts
	 * editor.setHoveredId('box1')
	 * editor.setHoveredId() // Clears the hovered shape.
	 * ```
	 *
	 * @param id - The id of the page to set as the current page
	 *
	 * @public
	 */
	setHoveredId(id: TLShapeId | null = null): this {
		if (id === this.pageState.hoveredId) return this

		this.setInstancePageState({ hoveredId: id }, true)
		return this
	}

	/**
	 * Set the current erasing shapes.
	 *
	 * @example
	 * ```ts
	 * editor.setErasingIds(['box1', 'box2'])
	 * editor.setErasingIds() // Clears the erasing set
	 * ```
	 *
	 * @param ids - The ids of shapes to set as erasing.
	 *
	 * @public
	 */
	setErasingIds(ids: TLShapeId[] = []): this {
		const erasingIds = this.erasingIdsSet
		if (ids.length === erasingIds.size && ids.every((id) => erasingIds.has(id))) return this

		this.setInstancePageState({ erasingIds: ids }, true)
		return this
	}

	/**
	 * Set the current cursor.
	 *
	 * @example
	 * ```ts
	 * editor.setCursor({ type: 'default' })
	 * editor.setCursor({ type: 'default', rotation: Math.PI / 2, color: 'red' })
	 * ```
	 *
	 * @param cursor - A partial of the cursor object.
	 *
	 * @public
	 */
	setCursor(cursor: Partial<TLCursor>): this {
		const current = this.cursor
		const next = {
			...current,
			rotation: 0,
			...cursor,
		}

		if (
			!(
				current.type === next.type &&
				current.rotation === next.rotation &&
				current.color === next.color
			)
		) {
			this.updateInstanceState({ cursor: next }, true)
		}

		return this
	}

	/**
	 * Set the current scribble.
	 *
	 * @example
	 * ```ts
	 * editor.setScribble(nextScribble)
	 * editor.setScribble() // clears the scribble
	 * ```
	 *
	 * @param scribble - The new scribble object.
	 *
	 * @public
	 */
	setScribble(scribble: TLScribble | null = null): this {
		this.updateInstanceState({ scribble }, true)
		return this
	}

	/**
	 * Set the current brush.
	 *
	 * @example
	 * ```ts
	 * editor.setBrush({ x: 0, y: 0, w: 100, h: 100 })
	 * editor.setBrush() // Clears the brush
	 * ```
	 *
	 * @param brush - The brush box model to set, or null for no brush model.
	 *
	 * @public
	 */
	setBrush(brush: Box2dModel | null = null): this {
		if (!brush && !this.brush) return this
		this.updateInstanceState({ brush }, true)
		return this
	}

	/**
	 * Set the current zoom brush.
	 *
	 * @example
	 * ```ts
	 * editor.setZoomBrush({ x: 0, y: 0, w: 100, h: 100 })
	 * editor.setZoomBrush() // Clears the zoom
	 * ```
	 *
	 * @param zoomBrush - The zoom box model to set, or null for no zoom model.
	 *
	 * @public
	 */
	setZoomBrush(zoomBrush: Box2dModel | null = null): this {
		if (!zoomBrush && !this.zoomBrush) return this
		this.updateInstanceState({ zoomBrush }, true)
		return this
	}

	/**
	 * Rotate shapes by a delta in radians.
	 *
	 * @example
	 * ```ts
	 * editor.rotateShapesBy(['box1', 'box2'], Math.PI)
	 * editor.rotateShapesBy(['box1', 'box2'], Math.PI / 2)
	 * ```
	 *
	 * @param ids - The ids of the shapes to move.
	 * @param delta - The delta in radians to apply to the selection rotation.
	 */
	rotateShapesBy(ids: TLShapeId[], delta: number): this {
		if (ids.length <= 0) return this

		const snapshot = getRotationSnapshot({ editor: this })
		applyRotationToSnapshotShapes({ delta, snapshot, editor: this, stage: 'one-off' })

		return this
	}

	/**
	 * Move shapes by a delta.
	 *
	 * @example
	 * ```ts
	 * editor.nudgeShapes(['box1', 'box2'], { x: 0, y: 1 })
	 * editor.nudgeShapes(['box1', 'box2'], { x: 0, y: 1 }, true)
	 * ```
	 *
	 * @param ids - The ids of the shapes to move.
	 * @param direction - The direction in which to move the shapes.
	 * @param major - Whether this is a major nudge, e.g. a shift + arrow nudge.
	 */
	nudgeShapes(ids: TLShapeId[], direction: Vec2dModel, major = false, ephemeral = false): this {
		if (ids.length <= 0) return this

		const step = this.isGridMode
			? major
				? this.gridSize * GRID_INCREMENT
				: this.gridSize
			: major
			? MAJOR_NUDGE_FACTOR
			: MINOR_NUDGE_FACTOR

		const steppedDelta = Vec2d.Mul(direction, step)
		const changes: TLShapePartial[] = []

		for (const id of ids) {
			const shape = this.getShapeById(id)

			if (!shape) {
				throw Error(`Could not find a shape with the id ${id}.`)
			}

			const localDelta = this.getDeltaInParentSpace(shape, steppedDelta)
			const translateStartChanges = this.getShapeUtil(shape).onTranslateStart?.(shape)

			changes.push(
				translateStartChanges
					? {
							...translateStartChanges,
							x: shape.x + localDelta.x,
							y: shape.y + localDelta.y,
					  }
					: {
							id,
							x: shape.x + localDelta.x,
							y: shape.y + localDelta.y,
							type: shape.type,
					  }
			)
		}

		this.updateShapes(changes, ephemeral)

		return this
	}

	/**
	 * Duplicate shapes.
	 *
	 * @example
	 * ```ts
	 * editor.duplicateShapes()
	 * editor.duplicateShapes(['id1', 'id2'])
	 * editor.duplicateShapes(['id1', 'id2'], { x: 8, y: 8 })
	 * ```
	 *
	 * @param ids - The ids of the shapes to duplicate. Defaults to the ids of the selected shapes.
	 * @param offset - The offset (in pixels) to apply to the duplicated shapes.
	 *
	 * @public
	 */
	duplicateShapes(ids: TLShapeId[] = this.selectedIds, offset?: VecLike): this {
		if (ids.length <= 0) return this

		const initialIds = new Set(ids)
		const idsToCreate: TLShapeId[] = []
		const idsToCheck = [...ids]

		while (idsToCheck.length > 0) {
			const id = idsToCheck.pop()
			if (!id) break
			idsToCreate.push(id)
			this.getSortedChildIds(id).forEach((childId) => idsToCheck.push(childId))
		}

		idsToCreate.reverse()

		const idsMap = new Map<any, TLShapeId>(idsToCreate.map((id) => [id, createShapeId()]))

		const shapesToCreate = compact(
			idsToCreate.map((id) => {
				const shape = this.getShapeById(id)

				if (!shape) {
					return null
				}

				const createId = idsMap.get(id)!

				let ox = 0
				let oy = 0

				if (offset && initialIds.has(id)) {
					const parentTransform = this.getParentTransform(shape)
					const vec = new Vec2d(offset.x, offset.y).rot(
						-Matrix2d.Decompose(parentTransform).rotation
					)
					ox = vec.x
					oy = vec.y
				}

				const parentId = shape.parentId ?? this.currentPageId
				const siblings = this.getSortedChildIds(parentId)
				const currentIndex = siblings.indexOf(shape.id)
				const siblingAboveId = siblings[currentIndex + 1]
				const siblingAbove = siblingAboveId ? this.getShapeById(siblingAboveId) : null

				const index = siblingAbove
					? getIndexBetween(shape.index, siblingAbove.index)
					: getIndexAbove(shape.index)

				let newShape: TLShape = deepCopy(shape)

				if (
					this.isShapeOfType(shape, ArrowShapeUtil) &&
					this.isShapeOfType(newShape, ArrowShapeUtil)
				) {
					const info = this.getShapeUtil(ArrowShapeUtil).getArrowInfo(shape)
					let newStartShapeId: TLShapeId | undefined = undefined
					let newEndShapeId: TLShapeId | undefined = undefined

					if (shape.props.start.type === 'binding') {
						newStartShapeId = idsMap.get(shape.props.start.boundShapeId)

						if (!newStartShapeId) {
							if (info?.isValid) {
								const { x, y } = info.start.point
								newShape.props.start = {
									type: 'point',
									x,
									y,
								}
							} else {
								const { start } = getArrowTerminalsInArrowSpace(this, shape)
								newShape.props.start = {
									type: 'point',
									x: start.x,
									y: start.y,
								}
							}
						}
					}

					if (shape.props.end.type === 'binding') {
						newEndShapeId = idsMap.get(shape.props.end.boundShapeId)
						if (!newEndShapeId) {
							if (info?.isValid) {
								const { x, y } = info.end.point
								newShape.props.end = {
									type: 'point',
									x,
									y,
								}
							} else {
								const { end } = getArrowTerminalsInArrowSpace(this, shape)
								newShape.props.start = {
									type: 'point',
									x: end.x,
									y: end.y,
								}
							}
						}
					}

					const infoAfter = getIsArrowStraight(newShape)
						? getStraightArrowInfo(this, newShape)
						: getCurvedArrowInfo(this, newShape)

					if (info?.isValid && infoAfter?.isValid && !getIsArrowStraight(shape)) {
						const mpA = Vec2d.Med(info.start.handle, info.end.handle)
						const distA = Vec2d.Dist(info.middle, mpA)
						const distB = Vec2d.Dist(infoAfter.middle, mpA)
						if (newShape.props.bend < 0) {
							newShape.props.bend += distB - distA
						} else {
							newShape.props.bend -= distB - distA
						}
					}

					if (newShape.props.start.type === 'binding' && newStartShapeId) {
						newShape.props.start.boundShapeId = newStartShapeId
					}

					if (newShape.props.end.type === 'binding' && newEndShapeId) {
						newShape.props.end.boundShapeId = newEndShapeId
					}
				}

				newShape = { ...newShape, id: createId, x: shape.x + ox, y: shape.y + oy, index }

				return newShape
			})
		)

		shapesToCreate.forEach((shape) => {
			if (isShapeId(shape.parentId)) {
				if (idsMap.has(shape.parentId)) {
					shape.parentId = idsMap.get(shape.parentId)!
				}
			}
		})

		this.history.batch(() => {
			const maxShapesReached = shapesToCreate.length + this.shapeIds.size > MAX_SHAPES_PER_PAGE

			if (maxShapesReached) {
				alertMaxShapes(this)
			}

			const newShapes = maxShapesReached
				? shapesToCreate.slice(0, MAX_SHAPES_PER_PAGE - this.shapeIds.size)
				: shapesToCreate

			const ids = newShapes.map((s) => s.id)

			this.createShapes(newShapes)
			this.setSelectedIds(ids)

			if (offset !== undefined) {
				// If we've offset the duplicated shapes, check to see whether their new bounds is entirely
				// contained in the current viewport. If not, then animate the camera to be centered on the
				// new shapes.
				const { viewportPageBounds, selectedPageBounds } = this
				if (selectedPageBounds && !viewportPageBounds.contains(selectedPageBounds)) {
					this.centerOnPoint(selectedPageBounds.center.x, selectedPageBounds.center.y, {
						duration: ANIMATION_MEDIUM_MS,
					})
				}
			}
		})

		return this
	}

	/**
	 * Set the current opacity. This will effect any selected shapes, or the
	 * next-created shape.
	 *
	 * @example
	 * ```ts
	 * editor.setOpacity(0.5)
	 * editor.setOpacity(0.5, true)
	 * ```
	 *
	 * @param opacity - The opacity to set. Must be a number between 0 and 1 inclusive.
	 * @param ephemeral - Whether the opacity change is ephemeral. Ephemeral changes don't get added to the undo/redo stack. Defaults to false.
	 * @param squashing - Whether the opacity change will be squashed into the existing history entry rather than creating a new one. Defaults to false.
	 */
	setOpacity(opacity: number, ephemeral = false, squashing = false): this {
		this.history.batch(() => {
			if (this.isIn('select')) {
				const {
					pageState: { selectedIds },
				} = this

				const shapesToUpdate: TLShape[] = []

				// We can have many deep levels of grouped shape
				// Making a recursive function to look through all the levels
				const addShapeById = (id: TLShape['id']) => {
					const shape = this.getShapeById(id)
					if (!shape) return
					if (this.isShapeOfType(shape, GroupShapeUtil)) {
						const childIds = this.getSortedChildIds(id)
						for (const childId of childIds) {
							addShapeById(childId)
						}
					} else {
						shapesToUpdate.push(shape)
					}
				}

				if (selectedIds.length > 0) {
					for (const id of selectedIds) {
						addShapeById(id)
					}

					this.updateShapes(
						shapesToUpdate.map((shape) => {
							return {
								id: shape.id,
								type: shape.type,
								opacity,
							}
						}),
						ephemeral
					)
				}
			}

			this.updateInstanceState({ opacityForNextShape: opacity }, ephemeral, squashing)
		})

		return this
	}

	/**
	 * Set the current props (generally styles).
	 *
	 * @example
	 * ```ts
	 * editor.setProp('color', 'red')
	 * editor.setProp('color', 'red', true)
	 * ```
	 *
	 * @param key - The key to set.
	 * @param value - The value to set.
	 * @param ephemeral - Whether the style change is ephemeral. Ephemeral changes don't get added to the undo/redo stack. Defaults to false.
	 * @param squashing - Whether the style change will be squashed into the existing history entry rather than creating a new one. Defaults to false.
	 *
	 * @public
	 */
	setProp(key: TLShapeProp, value: any, ephemeral = false, squashing = false): this {
		this.history.batch(() => {
			if (this.isIn('select')) {
				const {
					pageState: { selectedIds },
				} = this

				if (selectedIds.length > 0) {
					const shapesToUpdate: TLShape[] = []

					// We can have many deep levels of grouped shape
					// Making a recursive function to look through all the levels
					const addShapeById = (id: TLShape['id']) => {
						const shape = this.getShapeById(id)
						if (!shape) return
						if (this.isShapeOfType(shape, GroupShapeUtil)) {
							const childIds = this.getSortedChildIds(id)
							for (const childId of childIds) {
								addShapeById(childId)
							}
						} else if (shape!.props[key as keyof TLShape['props']] !== undefined) {
							shapesToUpdate.push(shape)
						}
					}

					for (const id of selectedIds) {
						addShapeById(id)
					}

					this.updateShapes(
						shapesToUpdate.map((shape) => {
							const props = { ...shape.props, [key]: value }
							if (key === 'color' && 'labelColor' in props) {
								props.labelColor = 'black'
							}

							return {
								id: shape.id,
								type: shape.type,
								props,
							}
						}),
						ephemeral
					)

					if (key !== 'color') {
						const changes: TLShapePartial[] = []

						for (const shape of shapesToUpdate) {
							const currentShape = this.getShapeById(shape.id)
							if (!currentShape) continue
							const util = this.getShapeUtil(currentShape)

							const boundsA = util.bounds(shape)
							const boundsB = util.bounds(currentShape)

							const change: TLShapePartial = { id: shape.id, type: shape.type }

							let didChange = false

							if (boundsA.width !== boundsB.width) {
								didChange = true

								if (this.isShapeOfType(shape, TextShapeUtil)) {
									switch (shape.props.align) {
										case 'middle': {
											change.x = currentShape.x + (boundsA.width - boundsB.width) / 2
											break
										}
										case 'end': {
											change.x = currentShape.x + boundsA.width - boundsB.width
											break
										}
									}
								} else {
									change.x = currentShape.x + (boundsA.width - boundsB.width) / 2
								}
							}

							if (boundsA.height !== boundsB.height) {
								didChange = true
								change.y = currentShape.y + (boundsA.height - boundsB.height) / 2
							}

							if (didChange) {
								changes.push(change)
							}
						}

						if (changes.length) {
							this.updateShapes(changes, ephemeral)
						}
					}
				}
			}

			this.updateInstanceState(
				{
					propsForNextShape: setPropsForNextShape(this.instanceState.propsForNextShape, {
						[key]: value,
					}),
				},
				ephemeral,
				squashing
			)
		})

		return this
	}

	/** @internal */
	private _willSetInitialBounds = true

	/** @internal */
	private _setCamera(x: number, y: number, z = this.camera.z): this {
		const currentCamera = this.camera
		if (currentCamera.x === x && currentCamera.y === y && currentCamera.z === z) return this
		const nextCamera = { ...currentCamera, x, y, z }

		this.batch(() => {
			this.store.put([nextCamera])

			const { currentScreenPoint } = this.inputs

			this.dispatch({
				type: 'pointer',
				target: 'canvas',
				name: 'pointer_move',
				point: currentScreenPoint,
				pointerId: 0,
				ctrlKey: this.inputs.ctrlKey,
				altKey: this.inputs.altKey,
				shiftKey: this.inputs.shiftKey,
				button: 0,
				isPen: this.isPenMode ?? false,
			})

			this._cameraManager.tick()
		})

		return this
	}

	/**
	 * Set the current camera.
	 *
	 * @example
	 * ```ts
	 * editor.setCamera(0, 0)
	 * editor.setCamera(0, 0, 1)
	 * ```
	 *
	 * @param x - The camera's x position.
	 * @param y - The camera's y position.
	 * @param z - The camera's z position. Defaults to the current zoom.
	 * @param options - Options for the camera change.
	 *
	 * @public
	 */
	setCamera(
		x: number,
		y: number,
		z = this.camera.z,
		{ stopFollowing = true }: TLViewportOptions = {}
	): this {
		this.stopCameraAnimation()
		if (stopFollowing && this.instanceState.followingUserId) {
			this.stopFollowingUser()
		}
		x = Number.isNaN(x) ? 0 : x
		y = Number.isNaN(y) ? 0 : y
		z = Number.isNaN(z) ? 1 : z
		this._setCamera(x, y, z)
		return this
	}

	/**
	 * Animate the camera.
	 *
	 * @example
	 * ```ts
	 * editor.animateCamera(0, 0)
	 * editor.animateCamera(0, 0, 1)
	 * editor.animateCamera(0, 0, 1, { duration: 1000, easing: (t) => t * t })
	 * ```
	 *
	 * @param x - The camera's x position.
	 * @param y - The camera's y position.
	 * @param z - The camera's z position. Defaults to the current zoom.
	 * @param opts - Options for the animation.
	 *
	 * @public
	 */
	animateCamera(
		x: number,
		y: number,
		z = this.camera.z,
		opts: TLAnimationOptions = DEFAULT_ANIMATION_OPTIONS
	): this {
		x = Number.isNaN(x) ? 0 : x
		y = Number.isNaN(y) ? 0 : y
		z = Number.isNaN(z) ? 1 : z
		const { width, height } = this.viewportScreenBounds
		const w = width / z
		const h = height / z

		const targetViewport = new Box2d(-x, -y, w, h)

		return this._animateToViewport(targetViewport, opts)
	}

	/**
	 * Center the camera on a point (in page space).
	 *
	 * @example
	 * ```ts
	 * editor.centerOnPoint(100, 100)
	 * ```
	 *
	 * @param x - The x position of the point.
	 * @param y - The y position of the point.
	 * @param opts - The options for an animation.
	 *
	 * @public
	 */
	centerOnPoint(x: number, y: number, opts?: TLAnimationOptions): this {
		if (!this.canMoveCamera) return this

		const {
			viewportPageBounds: { width: pw, height: ph },
			camera,
		} = this

		if (opts?.duration) {
			this.animateCamera(-(x - pw / 2), -(y - ph / 2), camera.z, opts)
		} else {
			this.setCamera(-(x - pw / 2), -(y - ph / 2), camera.z)
		}
		return this
	}

	/**
	 * Move the camera to the nearest content.
	 *
	 * @public
	 */
	zoomToContent() {
		const bounds = this.selectedPageBounds ?? this.allShapesCommonBounds

		if (bounds) {
			this.zoomToBounds(
				bounds.minX,
				bounds.minY,
				bounds.width,
				bounds.height,
				Math.min(1, this.zoomLevel),
				{ duration: 220 }
			)
		}

		return this
	}

	/**
	 * Zoom the camera to fit the current page's content in the viewport.
	 *
	 * @example
	 * ```ts
	 * editor.zoomToFit()
	 * ```
	 *
	 * @public
	 */
	zoomToFit(opts?: TLAnimationOptions): this {
		if (!this.canMoveCamera) return this

		const ids = [...this.shapeIds]
		if (ids.length <= 0) return this

		const pageBounds = Box2d.Common(compact(ids.map((id) => this.getPageBoundsById(id))))
		this.zoomToBounds(
			pageBounds.minX,
			pageBounds.minY,
			pageBounds.width,
			pageBounds.height,
			undefined,
			opts
		)
		return this
	}

	/**
	 * Set the zoom back to 100%.
	 *
	 * @example
	 * ```ts
	 * editor.resetZoom()
	 * ```
	 *
	 * @param opts - The options for an animation.
	 *
	 * @public
	 */
	resetZoom(point = this.viewportScreenCenter, opts?: TLAnimationOptions): this {
		if (!this.canMoveCamera) return this

		const { x: cx, y: cy, z: cz } = this.camera
		const { x, y } = point
		if (opts?.duration) {
			this.animateCamera(cx + (x / 1 - x) - (x / cz - x), cy + (y / 1 - y) - (y / cz - y), 1, opts)
		} else {
			this.setCamera(cx + (x / 1 - x) - (x / cz - x), cy + (y / 1 - y) - (y / cz - y), 1)
		}

		return this
	}

	/**
	 * Zoom the camera in.
	 *
	 * @example
	 * ```ts
	 * editor.zoomIn()
	 * editor.zoomIn(editor.viewportScreenCenter, { duration: 120 })
	 * editor.zoomIn(editor.inputs.currentScreenPoint, { duration: 120 })
	 * ```
	 *
	 * @param opts - The options for an animation.
	 *
	 * @public
	 */
	zoomIn(point = this.viewportScreenCenter, opts?: TLAnimationOptions): this {
		if (!this.canMoveCamera) return this

		const { x: cx, y: cy, z: cz } = this.camera

		let zoom = MAX_ZOOM

		for (let i = 1; i < ZOOMS.length; i++) {
			const z1 = ZOOMS[i - 1]
			const z2 = ZOOMS[i]
			if (z2 - cz <= (z2 - z1) / 2) continue
			zoom = z2
			break
		}

		const { x, y } = point
		if (opts?.duration) {
			this.animateCamera(
				cx + (x / zoom - x) - (x / cz - x),
				cy + (y / zoom - y) - (y / cz - y),
				zoom,
				opts
			)
		} else {
			this.setCamera(cx + (x / zoom - x) - (x / cz - x), cy + (y / zoom - y) - (y / cz - y), zoom)
		}

		return this
	}

	/**
	 * Zoom the camera out.
	 *
	 * @example
	 * ```ts
	 * editor.zoomOut()
	 * editor.zoomOut(editor.viewportScreenCenter, { duration: 120 })
	 * editor.zoomOut(editor.inputs.currentScreenPoint, { duration: 120 })
	 * ```
	 *
	 * @param opts - The options for an animation.
	 *
	 * @public
	 */
	zoomOut(point = this.viewportScreenCenter, opts?: TLAnimationOptions): this {
		if (!this.canMoveCamera) return this

		const { x: cx, y: cy, z: cz } = this.camera

		let zoom = MIN_ZOOM

		for (let i = ZOOMS.length - 1; i > 0; i--) {
			const z1 = ZOOMS[i - 1]
			const z2 = ZOOMS[i]
			if (z2 - cz >= (z2 - z1) / 2) continue
			zoom = z1
			break
		}

		const { x, y } = point

		if (opts?.duration) {
			this.animateCamera(
				cx + (x / zoom - x) - (x / cz - x),
				cy + (y / zoom - y) - (y / cz - y),
				zoom,
				opts
			)
		} else {
			this.setCamera(cx + (x / zoom - x) - (x / cz - x), cy + (y / zoom - y) - (y / cz - y), zoom)
		}

		return this
	}

	/**
	 * Zoom the camera to fit the current selection in the viewport.
	 *
	 * @example
	 * ```ts
	 * editor.zoomToSelection()
	 * ```
	 *
	 * @param opts - The options for an animation.
	 *
	 * @public
	 */
	zoomToSelection(opts?: TLAnimationOptions): this {
		if (!this.canMoveCamera) return this

		const ids = this.selectedIds
		if (ids.length <= 0) return this

		const selectedBounds = Box2d.Common(compact(ids.map((id) => this.getPageBoundsById(id))))

		this.zoomToBounds(
			selectedBounds.minX,
			selectedBounds.minY,
			selectedBounds.width,
			selectedBounds.height,
			Math.max(1, this.camera.z),
			opts
		)

		return this
	}

	/**
	 * Pan or pan/zoom the selected ids into view. This method tries to not change the zoom if possible.
	 *
	 * @param ids - The ids of the shapes to pan and zoom into view.
	 * @param opts - The options for an animation.
	 *
	 * @public
	 */
	panZoomIntoView(ids: TLShapeId[], opts?: TLAnimationOptions): this {
		if (!this.canMoveCamera) return this

		if (ids.length <= 0) return this
		const selectedBounds = Box2d.Common(compact(ids.map((id) => this.getPageBoundsById(id))))

		const { viewportPageBounds } = this

		if (viewportPageBounds.h < selectedBounds.h || viewportPageBounds.w < selectedBounds.w) {
			this.zoomToBounds(
				selectedBounds.minX,
				selectedBounds.minY,
				selectedBounds.width,
				selectedBounds.height,
				this.camera.z,
				opts
			)

			return this
		} else {
			// TODO: This buffer should calculate the 'active area' of the UI
			const bufferOffsets = this._activeAreaManager.offsets.value

			const pageTop = viewportPageBounds.y + bufferOffsets.top
			const pageRight = viewportPageBounds.maxY - bufferOffsets.right
			const pageBottom = viewportPageBounds.maxY - bufferOffsets.bottom
			const pageLeft = viewportPageBounds.x + bufferOffsets.left

			const selectedTop = selectedBounds.y
			const selectedRight = selectedBounds.maxX
			const selectedBottom = selectedBounds.maxY
			const selectedLeft = selectedBounds.x

			let offsetX = 0
			let offsetY = 0
			if (pageBottom < selectedBottom) {
				// off bottom
				offsetY = pageBottom - selectedBottom
			} else if (pageTop > selectedTop) {
				// off top
				offsetY = pageTop - selectedTop
			} else {
				// inside y-bounds
			}

			if (pageRight < selectedRight) {
				// off right
				offsetX = pageRight - selectedRight
			} else if (pageLeft > selectedLeft) {
				// off left
				offsetX = pageLeft - selectedLeft
			} else {
				// inside x-bounds
			}

			const { camera } = this

			if (opts?.duration) {
				this.animateCamera(camera.x + offsetX, camera.y + offsetY, camera.z, opts)
			} else {
				this.setCamera(camera.x + offsetX, camera.y + offsetY, camera.z)
			}
		}

		return this
	}

	/**
	 * Zoom the camera to fit a bounding box (in page space).
	 *
	 * @example
	 * ```ts
	 * editor.zoomToBounds(0, 0, 100, 100)
	 * ```
	 *
	 * @param x - The bounding box's x position.
	 * @param y - The bounding box's y position.
	 * @param width - The bounding box's width.
	 * @param height - The bounding box's height.
	 * @param targetZoom - The desired zoom level. Defaults to 0.1.
	 *
	 * @public
	 */
	zoomToBounds(
		x: number,
		y: number,
		width: number,
		height: number,
		targetZoom?: number,
		opts?: TLAnimationOptions
	): this {
		if (!this.canMoveCamera) return this

		const { viewportScreenBounds } = this

		const inset = Math.min(256, viewportScreenBounds.width * 0.28)

		let zoom = clamp(
			Math.min(
				(viewportScreenBounds.width - inset) / width,
				(viewportScreenBounds.height - inset) / height
			),
			MIN_ZOOM,
			MAX_ZOOM
		)

		if (targetZoom !== undefined) {
			zoom = Math.min(targetZoom, zoom)
		}

		if (opts?.duration) {
			this.animateCamera(
				-x + (viewportScreenBounds.width - width * zoom) / 2 / zoom,
				-y + (viewportScreenBounds.height - height * zoom) / 2 / zoom,
				zoom,
				opts
			)
		} else {
			this.setCamera(
				-x + (viewportScreenBounds.width - width * zoom) / 2 / zoom,
				-y + (viewportScreenBounds.height - height * zoom) / 2 / zoom,
				zoom
			)
		}

		return this
	}

	/**
	 * Pan the camera.
	 *
	 * @example
	 * ```ts
	 * editor.pan(100, 100)
	 * editor.pan(100, 100, { duration: 1000 })
	 * ```
	 *
	 * @param dx - The amount to pan on the x axis.
	 * @param dy - The amount to pan on the y axis.
	 * @param opts - The animation options
	 */
	pan(dx: number, dy: number, opts?: TLAnimationOptions): this {
		if (!this.canMoveCamera) return this

		const { camera } = this
		const { x: cx, y: cy, z: cz } = camera
		const d = new Vec2d(dx, dy).div(cz)

		if (opts?.duration ?? 0 > 0) {
			return this.animateCamera(cx + d.x, cy + d.y, cz, opts)
		} else {
			this.setCamera(cx + d.x, cy + d.y, cz)
		}

		return this
	}

	/**
	 * Stop the current camera animation, if any.
	 *
	 * @public
	 */
	stopCameraAnimation() {
		this.emit('stop-camera-animation')

		return this
	}

	/** @internal */
	private _viewportAnimation = null as null | {
		elapsed: number
		duration: number
		easing: (t: number) => number
		start: Box2d
		end: Box2d
	}

	/** @internal */
	private _animateViewport(ms: number) {
		if (!this._viewportAnimation) return

		const cancel = () => {
			this.removeListener('tick', this._animateViewport)
			this.removeListener('stop-camera-animation', cancel)
			this._viewportAnimation = null
		}

		this.once('stop-camera-animation', cancel)

		this._viewportAnimation.elapsed += ms

		const { elapsed, easing, duration, start, end } = this._viewportAnimation

		if (elapsed > duration) {
			const z = this.viewportScreenBounds.width / end.width
			const x = -end.x
			const y = -end.y

			this._setCamera(x, y, z)
			cancel()
			return
		}

		const remaining = duration - elapsed
		const t = easing(1 - remaining / duration)

		const left = start.minX + (end.minX - start.minX) * t
		const top = start.minY + (end.minY - start.minY) * t
		const right = start.maxX + (end.maxX - start.maxX) * t
		const bottom = start.maxY + (end.maxY - start.maxY) * t

		const easedViewport = new Box2d(left, top, right - left, bottom - top)

		const z = this.viewportScreenBounds.width / easedViewport.width
		const x = -easedViewport.x
		const y = -easedViewport.y

		this._setCamera(x, y, z)
	}

	/** @internal */
	private _animateToViewport(targetViewportPage: Box2d, opts = {} as TLAnimationOptions) {
		const { duration = 0, easing = EASINGS.easeInOutCubic } = opts
		const { animationSpeed, viewportPageBounds } = this

		// If we have an existing animation, then stop it; also stop following any user
		this.stopCameraAnimation()
		if (this.instanceState.followingUserId) {
			this.stopFollowingUser()
		}

		if (duration === 0 || animationSpeed === 0) {
			// If we have no animation, then skip the animation and just set the camera
			return this._setCamera(
				-targetViewportPage.x,
				-targetViewportPage.y,
				this.viewportScreenBounds.width / targetViewportPage.width
			)
		}

		// Set our viewport animation
		this._viewportAnimation = {
			elapsed: 0,
			duration: duration / animationSpeed,
			easing,
			start: viewportPageBounds.clone(),
			end: targetViewportPage,
		}

		// On each tick, animate the viewport
		this.addListener('tick', this._animateViewport)

		return this
	}

	/**
	 * Slide the camera in a certain direction.
	 *
	 * @param opts - Options for the slide
	 * @public
	 */
	slideCamera(
		opts = {} as {
			speed: number
			direction: Vec2d
			friction: number
			speedThreshold?: number
		}
	) {
		if (!this.canMoveCamera) return this

		this.stopCameraAnimation()

		const { animationSpeed } = this

		if (animationSpeed === 0) return

		const { speed, friction, direction, speedThreshold = 0.01 } = opts
		let currentSpeed = Math.min(speed, 1)

		const cancel = () => {
			this.removeListener('tick', moveCamera)
			this.removeListener('stop-camera-animation', cancel)
		}

		this.once('stop-camera-animation', cancel)

		const moveCamera = (elapsed: number) => {
			const { x: cx, y: cy, z: cz } = this.camera
			const movementVec = direction.clone().mul((currentSpeed * elapsed) / cz)

			// Apply friction
			currentSpeed *= 1 - friction
			if (currentSpeed < speedThreshold) {
				cancel()
			} else {
				this._setCamera(cx + movementVec.x, cy + movementVec.y, cz)
			}
		}

		this.addListener('tick', moveCamera)

		return this
	}

	/**
	 * Start viewport-following a user.
	 *
	 * @param userId - The id of the user to follow.
	 *
	 * @public
	 */
	startFollowingUser(userId: string) {
		// Currently, we get the leader's viewport page bounds from their user presence.
		// This is a placeholder until the ephemeral PR lands.
		// After that, we'll be able to get the required data from their instance presence instead.
		const leaderPresences = this.store.query.records('instance_presence', () => ({
			userId: { eq: userId },
		}))

		const thisUserId = this.user.id

		if (!thisUserId) {
			console.warn('You should set the userId for the current instance before following a user')
		}

		// If the leader is following us, then we can't follow them
		if (leaderPresences.value.some((p) => p.followingUserId === thisUserId)) {
			return
		}

		transact(() => {
			this.stopFollowingUser()

			this.updateInstanceState({ followingUserId: userId }, true)
		})

		const cancel = () => {
			this.removeListener('frame', moveTowardsUser)
			this.removeListener('stop-following', cancel)
		}

		let isCaughtUp = false

		const moveTowardsUser = () => {
			// Stop following if we can't find the user
			const leaderPresence = [...leaderPresences.value]
				.sort((a, b) => {
					return a.lastActivityTimestamp - b.lastActivityTimestamp
				})
				.pop()
			if (!leaderPresence) {
				this.stopFollowingUser()
				return
			}

			// Change page if leader is on a different page
			const isOnSamePage = leaderPresence.currentPageId === this.currentPageId
			const chaseProportion = isOnSamePage ? FOLLOW_CHASE_PROPORTION : 1
			if (!isOnSamePage) {
				this.setCurrentPageId(leaderPresence.currentPageId, { stopFollowing: false })
			}

			// Get the bounds of the follower (me) and the leader (them)
			const { center, width, height } = this.viewportPageBounds
			const leaderScreen = Box2d.From(leaderPresence.screenBounds)
			const leaderWidth = leaderScreen.width / leaderPresence.camera.z
			const leaderHeight = leaderScreen.height / leaderPresence.camera.z
			const leaderCenter = new Vec2d(
				leaderWidth / 2 - leaderPresence.camera.x,
				leaderHeight / 2 - leaderPresence.camera.y
			)

			// At this point, let's check if we're following someone who's following us.
			// If so, we can't try to contain their entire viewport
			// because that would become a feedback loop where we zoom, they zoom, etc.
			const isFollowingFollower = leaderPresence.followingUserId === thisUserId

			// Figure out how much to zoom
			const desiredWidth = width + (leaderWidth - width) * chaseProportion
			const desiredHeight = height + (leaderHeight - height) * chaseProportion
			const ratio = !isFollowingFollower
				? Math.min(width / desiredWidth, height / desiredHeight)
				: height / desiredHeight

			const targetZoom = clamp(this.camera.z * ratio, MIN_ZOOM, MAX_ZOOM)
			const targetWidth = this.viewportScreenBounds.w / targetZoom
			const targetHeight = this.viewportScreenBounds.h / targetZoom

			// Figure out where to move the camera
			const displacement = leaderCenter.sub(center)
			const targetCenter = Vec2d.Add(center, Vec2d.Mul(displacement, chaseProportion))

			// Now let's assess whether we've caught up to the leader or not
			const distance = Vec2d.Sub(targetCenter, center).len()
			const zoomChange = Math.abs(targetZoom - this.camera.z)

			// If we're chasing the leader...
			// Stop chasing if we're close enough
			if (distance < FOLLOW_CHASE_PAN_SNAP && zoomChange < FOLLOW_CHASE_ZOOM_SNAP) {
				isCaughtUp = true
				return
			}

			// If we're already caught up with the leader...
			// Only start moving again if we're far enough away
			if (
				isCaughtUp &&
				distance < FOLLOW_CHASE_PAN_UNSNAP &&
				zoomChange < FOLLOW_CHASE_ZOOM_UNSNAP
			) {
				return
			}

			// Update the camera!
			isCaughtUp = false
			this.stopCameraAnimation()
			this.setCamera(
				-(targetCenter.x - targetWidth / 2),
				-(targetCenter.y - targetHeight / 2),
				targetZoom,
				{ stopFollowing: false }
			)
		}

		this.once('stop-following', cancel)
		this.addListener('frame', moveTowardsUser)

		return this
	}

	/**
	 * Stop viewport-following a user.
	 *
	 * @public
	 */
	stopFollowingUser() {
		this.updateInstanceState({ followingUserId: null }, true)
		this.emit('stop-following')
		return this
	}

	/**
	 * Animate the camera to a shape.
	 *
	 * @public
	 */
	animateToShape(shapeId: TLShapeId, opts: TLAnimationOptions = DEFAULT_ANIMATION_OPTIONS): this {
		if (!this.canMoveCamera) return this

		const activeArea = getActiveAreaScreenSpace(this)
		const viewportAspectRatio = activeArea.width / activeArea.height

		const shapePageBounds = this.getPageBoundsById(shapeId)

		if (!shapePageBounds) return this

		const shapeAspectRatio = shapePageBounds.width / shapePageBounds.height

		const targetViewportPage = shapePageBounds.clone()

		const z = shapePageBounds.width / activeArea.width
		targetViewportPage.width += (activeArea.left + activeArea.right) * z
		targetViewportPage.height += (activeArea.top + activeArea.bottom) * z
		targetViewportPage.x -= activeArea.left * z
		targetViewportPage.y -= activeArea.top * z

		if (shapeAspectRatio > viewportAspectRatio) {
			targetViewportPage.height = shapePageBounds.width / viewportAspectRatio
			targetViewportPage.y -= (targetViewportPage.height - shapePageBounds.height) / 2
		} else {
			targetViewportPage.width = shapePageBounds.height * viewportAspectRatio
			targetViewportPage.x -= (targetViewportPage.width - shapePageBounds.width) / 2
		}

		return this._animateToViewport(targetViewportPage, opts)
	}

	/**
	 * Blur the app, cancelling any interaction state.
	 *
	 * @example
	 * ```ts
	 * editor.blur()
	 * ```
	 *
	 * @public
	 */
	blur() {
		this.complete()
		this.getContainer().blur()
		this._isFocused.set(false)
		return this
	}

	/**
	 * Focus the editor.
	 *
	 * @example
	 * ```ts
	 * editor.focus()
	 * ```
	 *
	 * @public
	 */
	focus() {
		this.getContainer().focus()
		this._isFocused.set(true)
		return this
	}

	/**
	 * Dispatch a cancel event.
	 *
	 * @example
	 * ```ts
	 * editor.cancel()
	 * ```
	 *
	 * @public
	 */
	cancel() {
		this.dispatch({ type: 'misc', name: 'cancel' })
		return this
	}

	/**
	 * Dispatch an interrupt event.
	 *
	 * @example
	 * ```ts
	 * editor.interrupt()
	 * ```
	 *
	 * @public
	 */
	interrupt() {
		this.dispatch({ type: 'misc', name: 'interrupt' })
		return this
	}

	/**
	 * Dispatch a complete event.
	 *
	 * @example
	 * ```ts
	 * editor.complete()
	 * ```
	 *
	 * @public
	 */
	complete() {
		this.dispatch({ type: 'misc', name: 'complete' })
		return this
	}

	/* -------------------- Callbacks ------------------- */

	/**
	 * Handle external content, such as files, urls, embeds, or plain text which has been put into the app, for example by pasting external text or dropping external images onto canvas.
	 *
	 * @param info - Info about the external content.
	 */
	async putExternalContent(info: TLExternalContent): Promise<void> {
		this.externalContentManager.handleContent(info)
	}

	/* ---------------- Text Measurement ---------------- */

	/**
	 * A helper for measuring text.
	 *
	 * @public
	 */
	textMeasure: TextManager

	/* --------------------- Groups --------------------- */

	/**
	 * Group some shapes together.
	 *
	 * @param ids - Ids of the shapes to group. Defaults to the selected shapes.
	 * @param groupId - Id of the group to create. Defaults to a new shape id.
	 *
	 * @public
	 */
	groupShapes(ids: TLShapeId[] = this.selectedIds, groupId = createShapeId()) {
		if (this.isReadOnly) return this

		if (ids.length <= 1) return this

		const shapes = compact(this._getUnlockedShapeIds(ids).map((id) => this.getShapeById(id)))
		const sortedShapeIds = shapes.sort(sortByIndex).map((s) => s.id)
		const pageBounds = Box2d.Common(compact(shapes.map((id) => this.getPageBounds(id))))

		const { x, y } = pageBounds.point

		const parentId = this.findCommonAncestor(shapes) ?? this.currentPageId

		// Only group when the select tool is active
		if (this.currentToolId !== 'select') return this

		// If not already in idle, cancel the current interaction (get back to idle)
		if (!this.isIn('select.idle')) {
			this.cancel()
		}

		// Find all the shapes that have the same parentId, and use the highest index.
		const shapesWithRootParent = shapes
			.filter((shape) => shape.parentId === parentId)
			.sort(sortByIndex)

		const highestIndex = shapesWithRootParent[shapesWithRootParent.length - 1]?.index

		this.batch(() => {
			this.createShapes<TLGroupShape>([
				{
					id: groupId,
					type: 'group',
					parentId,
					index: highestIndex,
					x,
					y,
					opacity: 1,
					props: {},
				},
			])
			this.reparentShapesById(sortedShapeIds, groupId)
			this.select(groupId)
		})

		return this
	}

	/**
	 * Ungroup some shapes.
	 *
	 * @param ids - Ids of the shapes to ungroup. Defaults to the selected shapes.
	 *
	 * @public
	 */
	ungroupShapes(ids: TLShapeId[] = this.selectedIds) {
		if (this.isReadOnly) return this
		if (ids.length === 0) return this

		// Only ungroup when the select tool is active
		if (this.currentToolId !== 'select') return this

		// If not already in idle, cancel the current interaction (get back to idle)
		if (!this.isIn('select.idle')) {
			this.cancel()
		}

		// The ids of the selected shapes after ungrouping;
		// these include all of the grouped shapes children,
		// plus any shapes that were selected apart from the groups.
		const idsToSelect = new Set<TLShapeId>()

		// Get all groups in the selection
		const shapes = compact(ids.map((id) => this.getShapeById(id)))

		const groups: TLGroupShape[] = []

		shapes.forEach((shape) => {
			if (this.isShapeOfType(shape, GroupShapeUtil)) {
				groups.push(shape)
			} else {
				idsToSelect.add(shape.id)
			}
		})

		if (groups.length === 0) return this

		this.batch(() => {
			let group: TLGroupShape

			for (let i = 0, n = groups.length; i < n; i++) {
				group = groups[i]
				const childIds = this.getSortedChildIds(group.id)

				for (let j = 0, n = childIds.length; j < n; j++) {
					idsToSelect.add(childIds[j])
				}

				this.reparentShapesById(childIds, group.parentId, group.index)
			}

			this.deleteShapes(groups.map((group) => group.id))
			this.select(...idsToSelect)
		})

		return this
	}
}

function alertMaxShapes(editor: Editor, pageId = editor.currentPageId) {
	const name = editor.getPageById(pageId)!.name
	editor.emit('max-shapes', { name, pageId, count: MAX_SHAPES_PER_PAGE })
}
