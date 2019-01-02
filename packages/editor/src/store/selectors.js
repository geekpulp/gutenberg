/**
 * External dependencies
 */
import {
	castArray,
	flatMap,
	find,
	first,
	get,
	has,
	includes,
	isArray,
	isBoolean,
	last,
	map,
	orderBy,
	reduce,
	some,
} from 'lodash';
import createSelector from 'rememo';

/**
 * WordPress dependencies
 */
import {
	serialize,
	getBlockType,
	getBlockTypes,
	hasBlockSupport,
	hasChildBlocksWithInserterSupport,
	getFreeformContentHandlerName,
	isUnmodifiedDefaultBlock,
} from '@wordpress/blocks';
import { isInTheFuture, getDate } from '@wordpress/date';
import { removep } from '@wordpress/autop';
import { addQueryArgs } from '@wordpress/url';
import { select } from '@wordpress/data';
import deprecated from '@wordpress/deprecated';

/**
 * Internal dependencies
 */
import { PREFERENCES_DEFAULTS } from './defaults';
import { EDIT_MERGE_PROPERTIES } from './constants';

/***
 * Module constants
 */
export const POST_UPDATE_TRANSACTION_ID = 'post-update';
const PERMALINK_POSTNAME_REGEX = /%(?:postname|pagename)%/;
export const INSERTER_UTILITY_HIGH = 3;
export const INSERTER_UTILITY_MEDIUM = 2;
export const INSERTER_UTILITY_LOW = 1;
export const INSERTER_UTILITY_NONE = 0;
const MILLISECONDS_PER_HOUR = 3600 * 1000;
const MILLISECONDS_PER_DAY = 24 * 3600 * 1000;
const MILLISECONDS_PER_WEEK = 7 * 24 * 3600 * 1000;
const ONE_MINUTE_IN_MS = 60 * 1000;

/**
 * Shared reference to an empty array for cases where it is important to avoid
 * returning a new array reference on every invocation, as in a connected or
 * other pure component which performs `shouldComponentUpdate` check on props.
 * This should be used as a last resort, since the normalized data should be
 * maintained by the reducer result in state.
 *
 * @type {Array}
 */
const EMPTY_ARRAY = [];

/**
 * Returns true if any past editor history snapshots exist, or false otherwise.
 *
 * @param {Object} state Global application state.
 *
 * @return {boolean} Whether undo history exists.
 */
export function hasEditorUndo( state ) {
	return state.editor.past.length > 0;
}

/**
 * Returns true if any future editor history snapshots exist, or false
 * otherwise.
 *
 * @param {Object} state Global application state.
 *
 * @return {boolean} Whether redo history exists.
 */
export function hasEditorRedo( state ) {
	return state.editor.future.length > 0;
}

/**
 * Returns true if the currently edited post is yet to be saved, or false if
 * the post has been saved.
 *
 * @param {Object} state Global application state.
 *
 * @return {boolean} Whether the post is new.
 */
export function isEditedPostNew( state ) {
	return getCurrentPost( state ).status === 'auto-draft';
}

/**
 * Returns true if content includes unsaved changes, or false otherwise.
 *
 * @param {Object} state Editor state.
 *
 * @return {boolean} Whether content includes unsaved changes.
 */
export function hasChangedContent( state ) {
	return (
		state.editor.present.blocks.isDirty ||

		// `edits` is intended to contain only values which are different from
		// the saved post, so the mere presence of a property is an indicator
		// that the value is different than what is known to be saved. While
		// content in Visual mode is represented by the blocks state, in Text
		// mode it is tracked by `edits.content`.
		'content' in state.editor.present.edits
	);
}

/**
 * Returns true if there are unsaved values for the current edit session, or
 * false if the editing state matches the saved or new post.
 *
 * @param {Object} state Global application state.
 *
 * @return {boolean} Whether unsaved values exist.
 */
export function isEditedPostDirty( state ) {
	if ( hasChangedContent( state ) ) {
		return true;
	}

	// Edits should contain only fields which differ from the saved post (reset
	// at initial load and save complete). Thus, a non-empty edits state can be
	// inferred to contain unsaved values.
	if ( Object.keys( state.editor.present.edits ).length > 0 ) {
		return true;
	}

	// Edits and change detectiona are reset at the start of a save, but a post
	// is still considered dirty until the point at which the save completes.
	// Because the save is performed optimistically, the prior states are held
	// until committed. These can be referenced to determine whether there's a
	// chance that state may be reverted into one considered dirty.
	return inSomeHistory( state, isEditedPostDirty );
}

/**
 * Returns true if there are no unsaved values for the current edit session and
 * if the currently edited post is new (has never been saved before).
 *
 * @param {Object} state Global application state.
 *
 * @return {boolean} Whether new post and unsaved values exist.
 */
export function isCleanNewPost( state ) {
	return ! isEditedPostDirty( state ) && isEditedPostNew( state );
}

/**
 * Returns the post currently being edited in its last known saved state, not
 * including unsaved edits. Returns an object containing relevant default post
 * values if the post has not yet been saved.
 *
 * @param {Object} state Global application state.
 *
 * @return {Object} Post object.
 */
export function getCurrentPost( state ) {
	return state.currentPost;
}

/**
 * Returns the post type of the post currently being edited.
 *
 * @param {Object} state Global application state.
 *
 * @return {string} Post type.
 */
export function getCurrentPostType( state ) {
	return state.currentPost.type;
}

/**
 * Returns the ID of the post currently being edited, or null if the post has
 * not yet been saved.
 *
 * @param {Object} state Global application state.
 *
 * @return {?number} ID of current post.
 */
export function getCurrentPostId( state ) {
	return getCurrentPost( state ).id || null;
}

/**
 * Returns the number of revisions of the post currently being edited.
 *
 * @param {Object} state Global application state.
 *
 * @return {number} Number of revisions.
 */
export function getCurrentPostRevisionsCount( state ) {
	return get( getCurrentPost( state ), [ '_links', 'version-history', 0, 'count' ], 0 );
}

/**
 * Returns the last revision ID of the post currently being edited,
 * or null if the post has no revisions.
 *
 * @param {Object} state Global application state.
 *
 * @return {?number} ID of the last revision.
 */
export function getCurrentPostLastRevisionId( state ) {
	return get( getCurrentPost( state ), [ '_links', 'predecessor-version', 0, 'id' ], null );
}

/**
 * Returns any post values which have been changed in the editor but not yet
 * been saved.
 *
 * @param {Object} state Global application state.
 *
 * @return {Object} Object of key value pairs comprising unsaved edits.
 */
export const getPostEdits = createSelector(
	( state ) => {
		return {
			...state.initialEdits,
			...state.editor.present.edits,
		};
	},
	( state ) => [
		state.editor.present.edits,
		state.initialEdits,
	]
);

/**
 * Returns a new reference when edited values have changed. This is useful in
 * inferring where an edit has been made between states by comparison of the
 * return values using strict equality.
 *
 * @example
 *
 * ```
 * const hasEditOccurred = (
 *    getReferenceByDistinctEdits( beforeState ) !==
 *    getReferenceByDistinctEdits( afterState )
 * );
 * ```
 *
 * @param {Object} state Editor state.
 *
 * @return {*} A value whose reference will change only when an edit occurs.
 */
export const getReferenceByDistinctEdits = createSelector(
	() => [],
	( state ) => [ state.editor ],
);

/**
 * Returns an attribute value of the saved post.
 *
 * @param {Object} state         Global application state.
 * @param {string} attributeName Post attribute name.
 *
 * @return {*} Post attribute value.
 */
export function getCurrentPostAttribute( state, attributeName ) {
	const post = getCurrentPost( state );
	if ( post.hasOwnProperty( attributeName ) ) {
		return post[ attributeName ];
	}
}

/**
 * Returns a single attribute of the post being edited, preferring the unsaved
 * edit if one exists, but falling back to the attribute for the last known
 * saved state of the post.
 *
 * @param {Object} state         Global application state.
 * @param {string} attributeName Post attribute name.
 *
 * @return {*} Post attribute value.
 */
export function getEditedPostAttribute( state, attributeName ) {
	// Special cases
	switch ( attributeName ) {
		case 'content':
			return getEditedPostContent( state );
	}

	// Fall back to saved post value if not edited.
	const edits = getPostEdits( state );
	if ( ! edits.hasOwnProperty( attributeName ) ) {
		return getCurrentPostAttribute( state, attributeName );
	}

	// Merge properties are objects which contain only the patch edit in state,
	// and thus must be merged with the current post attribute.
	if ( EDIT_MERGE_PROPERTIES.has( attributeName ) ) {
		// [TODO]: Since this will return a new reference on each invocation,
		// consider caching in a way which would not impact non-merged property
		// derivation. Alternatively, introduce a new selector for meta lookup.
		return {
			...getCurrentPostAttribute( state, attributeName ),
			...edits[ attributeName ],
		};
	}

	return edits[ attributeName ];
}

/**
 * Returns an attribute value of the current autosave revision for a post, or
 * null if there is no autosave for the post.
 *
 * @param {Object} state         Global application state.
 * @param {string} attributeName Autosave attribute name.
 *
 * @return {*} Autosave attribute value.
 */
export function getAutosaveAttribute( state, attributeName ) {
	deprecated( 'getAutosaveAttribute selector (`core/editor` store)', {
		alternative: 'getAutosaveAttribute selector (`core` store)',
		plugin: 'Gutenberg',
	} );

	const postId = getCurrentPostId( state );
	return select( 'core' ).getAutosaveAttribute( postId, attributeName );
}

/**
 * Returns the current visibility of the post being edited, preferring the
 * unsaved value if different than the saved post. The return value is one of
 * "private", "password", or "public".
 *
 * @param {Object} state Global application state.
 *
 * @return {string} Post visibility.
 */
export function getEditedPostVisibility( state ) {
	const status = getEditedPostAttribute( state, 'status' );
	if ( status === 'private' ) {
		return 'private';
	}

	const password = getEditedPostAttribute( state, 'password' );
	if ( password ) {
		return 'password';
	}

	return 'public';
}

/**
 * Returns true if post is pending review.
 *
 * @param {Object} state Global application state.
 *
 * @return {boolean} Whether current post is pending review.
 */
export function isCurrentPostPending( state ) {
	return getCurrentPost( state ).status === 'pending';
}

/**
 * Return true if the current post has already been published.
 *
 * @param {Object} state Global application state.
 *
 * @return {boolean} Whether the post has been published.
 */
export function isCurrentPostPublished( state ) {
	const post = getCurrentPost( state );

	return [ 'publish', 'private' ].indexOf( post.status ) !== -1 ||
		( post.status === 'future' && ! isInTheFuture( new Date( Number( getDate( post.date ) ) - ONE_MINUTE_IN_MS ) ) );
}

/**
 * Returns true if post is already scheduled.
 *
 * @param {Object} state Global application state.
 *
 * @return {boolean} Whether current post is scheduled to be posted.
 */
export function isCurrentPostScheduled( state ) {
	return getCurrentPost( state ).status === 'future' && ! isCurrentPostPublished( state );
}

/**
 * Return true if the post being edited can be published.
 *
 * @param {Object} state Global application state.
 *
 * @return {boolean} Whether the post can been published.
 */
export function isEditedPostPublishable( state ) {
	const post = getCurrentPost( state );

	// TODO: Post being publishable should be superset of condition of post
	// being saveable. Currently this restriction is imposed at UI.
	//
	//  See: <PostPublishButton /> (`isButtonEnabled` assigned by `isSaveable`)

	return isEditedPostDirty( state ) || [ 'publish', 'private', 'future' ].indexOf( post.status ) === -1;
}

/**
 * Returns true if the post can be saved, or false otherwise. A post must
 * contain a title, an excerpt, or non-empty content to be valid for save.
 *
 * @param {Object} state Global application state.
 *
 * @return {boolean} Whether the post can be saved.
 */
export function isEditedPostSaveable( state ) {
	if ( isSavingPost( state ) ) {
		return false;
	}

	// TODO: Post should not be saveable if not dirty. Cannot be added here at
	// this time since posts where meta boxes are present can be saved even if
	// the post is not dirty. Currently this restriction is imposed at UI, but
	// should be moved here.
	//
	//  See: `isEditedPostPublishable` (includes `isEditedPostDirty` condition)
	//  See: <PostSavedState /> (`forceIsDirty` prop)
	//  See: <PostPublishButton /> (`forceIsDirty` prop)
	//  See: https://github.com/WordPress/gutenberg/pull/4184

	return (
		!! getEditedPostAttribute( state, 'title' ) ||
		!! getEditedPostAttribute( state, 'excerpt' ) ||
		! isEditedPostEmpty( state )
	);
}

/**
 * Returns true if the edited post has content. A post has content if it has at
 * least one saveable block or otherwise has a non-empty content property
 * assigned.
 *
 * @param {Object} state Global application state.
 *
 * @return {boolean} Whether post has content.
 */
export function isEditedPostEmpty( state ) {
	const blocks = getBlocksForSerialization( state );

	// While the condition of truthy content string is sufficient to determine
	// emptiness, testing saveable blocks length is a trivial operation. Since
	// this function can be called frequently, optimize for the fast case as a
	// condition of the mere existence of blocks. Note that the value of edited
	// content is used in place of blocks, thus allowed to fall through.
	if ( blocks.length && ! ( 'content' in getPostEdits( state ) ) ) {
		// Pierce the abstraction of the serializer in knowing that blocks are
		// joined with with newlines such that even if every individual block
		// produces an empty save result, the serialized content is non-empty.
		if ( blocks.length > 1 ) {
			return false;
		}

		// Freeform and unregistered blocks omit comment delimiters in their
		// output. The freeform block specifically may produce an empty string
		// to save. In the case of a single freeform block, fall through to the
		// full serialize. Otherwise, the single block is assumed non-empty by
		// virtue of its comment delimiters.
		if ( blocks[ 0 ].name !== getFreeformContentHandlerName() ) {
			return false;
		}
	}

	return ! getEditedPostContent( state );
}

/**
 * Returns true if the post can be autosaved, or false otherwise.
 *
 * @param  {Object} state    Global application state.
 * @param  {Object} autosave An autosave object.
 *
 * @return {boolean} Whether the post can be autosaved.
 */
export function isEditedPostAutosaveable( state, autosave ) {
	if ( arguments.length === 1 ) {
		deprecated( '`wp.data.select( \'core/editor\' ).isEditedPostAutosaveable()`', {
			alternative: '`wp.data.select( \'core/editor\' ).isEditedPostAutosaveable( autosave )`',
			plugin: 'Gutenberg',
		} );

		const postId = getCurrentPostId( state );
		autosave = select( 'core' ).getAutosave( postId );
	}

	// A post must contain a title, an excerpt, or non-empty content to be valid for autosaving.
	if ( ! isEditedPostSaveable( state ) ) {
		return false;
	}

	// If we don't already have an autosave, the post is autosaveable.
	if ( ! autosave ) {
		return true;
	}

	// To avoid an expensive content serialization, use the content dirtiness
	// flag in place of content field comparison against the known autosave.
	// This is not strictly accurate, and relies on a tolerance toward autosave
	// request failures for unnecessary saves.
	if ( hasChangedContent( state ) ) {
		return true;
	}

	// If the title, excerpt or content has changed, the post is autosaveable.
	return [ 'title', 'excerpt' ].some( ( field ) => (
		autosave[ field ] !== getEditedPostAttribute( state, field )
	) );
}

/**
 * Returns the current autosave, or null if one is not set (i.e. if the post
 * has yet to be autosaved, or has been saved or published since the last
 * autosave).
 *
 * @param {Object} state Editor state.
 *
 * @return {?Object} Current autosave, if exists.
 */
export function getAutosave( state ) {
	deprecated( 'getAutosave selector (`core/editor` store)', {
		alternative: 'getAutosave selector (`core` store)',
		plugin: 'Gutenberg',
	} );

	const postId = getCurrentPostId( state );
	return select( 'core' ).getAutosave( postId );
}

/**
 * Returns the true if there is an existing autosave, otherwise false.
 *
 * @param {Object} state Global application state.
 *
 * @return {boolean} Whether there is an existing autosave.
 */
export function hasAutosave( state ) {
	deprecated( 'hasAutosave selector (`core/editor` store)', {
		alternative: 'hasAutosave selector (`core` store)',
		plugin: 'Gutenberg',
	} );

	const postId = getCurrentPostId( state );
	return select( 'core' ).hasAutosave( postId );
}

/**
 * Return true if the post being edited is being scheduled. Preferring the
 * unsaved status values.
 *
 * @param {Object} state Global application state.
 *
 * @return {boolean} Whether the post has been published.
 */
export function isEditedPostBeingScheduled( state ) {
	const date = getEditedPostAttribute( state, 'date' );
	// Offset the date by one minute (network latency)
	const checkedDate = new Date( Number( getDate( date ) ) - ONE_MINUTE_IN_MS );

	return isInTheFuture( checkedDate );
}

/**
 * Returns whether the current post should be considered to have a "floating"
 * date (i.e. that it would publish "Immediately" rather than at a set time).
 *
 * Unlike in the PHP backend, the REST API returns a full date string for posts
 * where the 0000-00-00T00:00:00 placeholder is present in the database. To
 * infer that a post is set to publish "Immediately" we check whether the date
 * and modified date are the same.
 *
 * @param  {Object}  state Editor state.
 *
 * @return {boolean} Whether the edited post has a floating date value.
 */
export function isEditedPostDateFloating( state ) {
	const date = getEditedPostAttribute( state, 'date' );
	const modified = getEditedPostAttribute( state, 'modified' );
	const status = getEditedPostAttribute( state, 'status' );
	if ( status === 'draft' || status === 'auto-draft' ) {
		return date === modified;
	}
	return false;
}

/**
 * Returns a new reference when the inner blocks of a given block client ID
 * change. This is used exclusively as a memoized selector dependant, relying
 * on this selector's shared return value and recursively those of its inner
 * blocks defined as dependencies. This abuses mechanics of the selector
 * memoization to return from the original selector function only when
 * dependants change.
 *
 * @param {Object} state    Editor state.
 * @param {string} clientId Block client ID.
 *
 * @return {*} A value whose reference will change only when inner blocks of
 *             the given block client ID change.
 */
export const getBlockDependantsCacheBust = createSelector(
	() => [],
	( state, clientId ) => map(
		getBlockOrder( state, clientId ),
		( innerBlockClientId ) => getBlock( state, innerBlockClientId ),
	),
);

/**
 * Returns a block's name given its client ID, or null if no block exists with
 * the client ID.
 *
 * @param {Object} state    Editor state.
 * @param {string} clientId Block client ID.
 *
 * @return {string} Block name.
 */
export function getBlockName( state, clientId ) {
	const block = state.editor.present.blocks.byClientId[ clientId ];
	return block ? block.name : null;
}

/**
 * Returns whether a block is valid or not.
 *
 * @param {Object} state    Editor state.
 * @param {string} clientId Block client ID.
 *
 * @return {boolean} Is Valid.
 */
export function isBlockValid( state, clientId ) {
	const block = state.editor.present.blocks.byClientId[ clientId ];
	return !! block && block.isValid;
}

/**
 * Returns a block's attributes given its client ID, or null if no block exists with
 * the client ID.
 *
 * @param {Object} state    Editor state.
 * @param {string} clientId Block client ID.
 *
 * @return {Object?} Block attributes.
 */
export const getBlockAttributes = createSelector(
	( state, clientId ) => {
		const block = state.editor.present.blocks.byClientId[ clientId ];
		if ( ! block ) {
			return null;
		}

		let attributes = state.editor.present.blocks.attributes[ clientId ];

		// Inject custom source attribute values.
		//
		// TODO: Create generic external sourcing pattern, not explicitly
		// targeting meta attributes.
		const type = getBlockType( block.name );
		if ( type ) {
			attributes = reduce( type.attributes, ( result, value, key ) => {
				if ( value.source === 'meta' ) {
					if ( result === attributes ) {
						result = { ...result };
					}

					result[ key ] = getPostMeta( state, value.meta );
				}

				return result;
			}, attributes );
		}

		return attributes;
	},
	( state, clientId ) => [
		state.editor.present.blocks.byClientId[ clientId ],
		state.editor.present.blocks.attributes[ clientId ],
		state.editor.present.edits.meta,
		state.initialEdits.meta,
		state.currentPost.meta,
	]
);

/**
 * Returns a block given its client ID. This is a parsed copy of the block,
 * containing its `blockName`, `clientId`, and current `attributes` state. This
 * is not the block's registration settings, which must be retrieved from the
 * blocks module registration store.
 *
 * @param {Object} state    Editor state.
 * @param {string} clientId Block client ID.
 *
 * @return {Object} Parsed block object.
 */
export const getBlock = createSelector(
	( state, clientId ) => {
		const block = state.editor.present.blocks.byClientId[ clientId ];
		if ( ! block ) {
			return null;
		}

		return {
			...block,
			attributes: getBlockAttributes( state, clientId ),
			innerBlocks: getBlocks( state, clientId ),
		};
	},
	( state, clientId ) => [
		...getBlockAttributes.getDependants( state, clientId ),
		getBlockDependantsCacheBust( state, clientId ),
	]
);

export const __unstableGetBlockWithoutInnerBlocks = createSelector(
	( state, clientId ) => {
		const block = state.editor.present.blocks.byClientId[ clientId ];
		if ( ! block ) {
			return null;
		}

		return {
			...block,
			attributes: getBlockAttributes( state, clientId ),
		};
	},
	( state, clientId ) => [
		state.editor.present.blocks.byClientId[ clientId ],
		...getBlockAttributes.getDependants( state, clientId ),
	]
);

function getPostMeta( state, key ) {
	return has( state, [ 'editor', 'present', 'edits', 'meta', key ] ) ?
		get( state, [ 'editor', 'present', 'edits', 'meta', key ] ) :
		get( state, [ 'currentPost', 'meta', key ] );
}

/**
 * Returns all block objects for the current post being edited as an array in
 * the order they appear in the post.
 *
 * Note: It's important to memoize this selector to avoid return a new instance
 * on each call
 *
 * @param {Object}  state        Editor state.
 * @param {?String} rootClientId Optional root client ID of block list.
 *
 * @return {Object[]} Post blocks.
 */
export const getBlocks = createSelector(
	( state, rootClientId ) => {
		return map(
			getBlockOrder( state, rootClientId ),
			( clientId ) => getBlock( state, clientId )
		);
	},
	( state ) => [ state.editor.present.blocks ]
);

/**
 * Returns an array containing the clientIds of all descendants
 * of the blocks given.
 *
 * @param {Object} state Global application state.
 * @param {Array} clientIds Array of blocks to inspect.
 *
 * @return {Array} ids of descendants.
 */
export const getClientIdsOfDescendants = ( state, clientIds ) => flatMap( clientIds, ( clientId ) => {
	const descendants = getBlockOrder( state, clientId );
	return [ ...descendants, ...getClientIdsOfDescendants( state, descendants ) ];
} );

/**
 * Returns an array containing the clientIds of the top-level blocks
 * and their descendants of any depth (for nested blocks).
 *
 * @param {Object} state Global application state.
 *
 * @return {Array} ids of top-level and descendant blocks.
 */
export const getClientIdsWithDescendants = createSelector(
	( state ) => {
		const topLevelIds = getBlockOrder( state );
		return [ ...topLevelIds, ...getClientIdsOfDescendants( state, topLevelIds ) ];
	},
	( state ) => [
		state.editor.present.blocks.order,
	]
);

/**
 * Returns the total number of blocks, or the total number of blocks with a specific name in a post.
 * The number returned includes nested blocks.
 *
 * @param {Object}  state     Global application state.
 * @param {?String} blockName Optional block name, if specified only blocks of that type will be counted.
 *
 * @return {number} Number of blocks in the post, or number of blocks with name equal to blockName.
 */
export const getGlobalBlockCount = createSelector(
	( state, blockName ) => {
		const clientIds = getClientIdsWithDescendants( state );
		if ( ! blockName ) {
			return clientIds.length;
		}
		return reduce( clientIds, ( count, clientId ) => {
			const block = state.editor.present.blocks.byClientId[ clientId ];
			return block.name === blockName ? count + 1 : count;
		}, 0 );
	},
	( state ) => [
		state.editor.present.blocks.order,
		state.editor.present.blocks.byClientId,
	]
);

/**
 * Given an array of block client IDs, returns the corresponding array of block
 * objects.
 *
 * @param {Object}   state     Editor state.
 * @param {string[]} clientIds Client IDs for which blocks are to be returned.
 *
 * @return {WPBlock[]} Block objects.
 */
export const getBlocksByClientId = createSelector(
	( state, clientIds ) => map(
		castArray( clientIds ),
		( clientId ) => getBlock( state, clientId )
	),
	( state ) => [
		state.editor.present.edits.meta,
		state.initialEdits.meta,
		state.currentPost.meta,
		state.editor.present.blocks,
	]
);

/**
 * Returns the number of blocks currently present in the post.
 *
 * @param {Object}  state        Editor state.
 * @param {?string} rootClientId Optional root client ID of block list.
 *
 * @return {number} Number of blocks in the post.
 */
export function getBlockCount( state, rootClientId ) {
	return getBlockOrder( state, rootClientId ).length;
}

/**
 * Returns the current block selection start. This value may be null, and it
 * may represent either a singular block selection or multi-selection start.
 * A selection is singular if its start and end match.
 *
 * @param {Object} state Global application state.
 *
 * @return {?string} Client ID of block selection start.
 */
export function getBlockSelectionStart( state ) {
	return state.blockSelection.start;
}

/**
 * Returns the current block selection end. This value may be null, and it
 * may represent either a singular block selection or multi-selection end.
 * A selection is singular if its start and end match.
 *
 * @param {Object} state Global application state.
 *
 * @return {?string} Client ID of block selection end.
 */
export function getBlockSelectionEnd( state ) {
	return state.blockSelection.end;
}

/**
 * Returns the number of blocks currently selected in the post.
 *
 * @param {Object} state Global application state.
 *
 * @return {number} Number of blocks selected in the post.
 */
export function getSelectedBlockCount( state ) {
	const multiSelectedBlockCount = getMultiSelectedBlockClientIds( state ).length;

	if ( multiSelectedBlockCount ) {
		return multiSelectedBlockCount;
	}

	return state.blockSelection.start ? 1 : 0;
}

/**
 * Returns true if there is a single selected block, or false otherwise.
 *
 * @param {Object} state Editor state.
 *
 * @return {boolean} Whether a single block is selected.
 */
export function hasSelectedBlock( state ) {
	const { start, end } = state.blockSelection;
	return !! start && start === end;
}

/**
 * Returns the currently selected block client ID, or null if there is no
 * selected block.
 *
 * @param {Object} state Editor state.
 *
 * @return {?string} Selected block client ID.
 */
export function getSelectedBlockClientId( state ) {
	const { start, end } = state.blockSelection;
	// We need to check the block exists because the current state.blockSelection reducer
	// doesn't take into account the UNDO / REDO actions to update selection.
	// To be removed when that's fixed.
	return start && start === end && !! state.editor.present.blocks.byClientId[ start ] ? start : null;
}

/**
 * Returns the currently selected block, or null if there is no selected block.
 *
 * @param {Object} state Global application state.
 *
 * @return {?Object} Selected block.
 */
export function getSelectedBlock( state ) {
	const clientId = getSelectedBlockClientId( state );
	return clientId ? getBlock( state, clientId ) : null;
}

/**
 * Given a block client ID, returns the root block from which the block is
 * nested, an empty string for top-level blocks, or null if the block does not
 * exist.
 *
 * @param {Object} state    Editor state.
 * @param {string} clientId Block from which to find root client ID.
 *
 * @return {?string} Root client ID, if exists
 */
export const getBlockRootClientId = createSelector(
	( state, clientId ) => {
		const { order } = state.editor.present.blocks;

		for ( const rootClientId in order ) {
			if ( includes( order[ rootClientId ], clientId ) ) {
				return rootClientId;
			}
		}

		return null;
	},
	( state ) => [
		state.editor.present.blocks.order,
	]
);

/**
 * Given a block client ID, returns the root of the hierarchy from which the block is nested, return the block itself for root level blocks.
 *
 * @param {Object} state    Editor state.
 * @param {string} clientId Block from which to find root client ID.
 *
 * @return {string} Root client ID
 */
export const getBlockHierarchyRootClientId = createSelector(
	( state, clientId ) => {
		let rootClientId = clientId;
		let current = clientId;
		while ( rootClientId ) {
			current = rootClientId;
			rootClientId = getBlockRootClientId( state, current );
		}

		return current;
	},
	( state ) => [
		state.editor.present.blocks.order,
	]
);

/**
 * Returns the client ID of the block adjacent one at the given reference
 * startClientId and modifier directionality. Defaults start startClientId to
 * the selected block, and direction as next block. Returns null if there is no
 * adjacent block.
 *
 * @param {Object}  state         Editor state.
 * @param {?string} startClientId Optional client ID of block from which to
 *                                search.
 * @param {?number} modifier      Directionality multiplier (1 next, -1
 *                                previous).
 *
 * @return {?string} Return the client ID of the block, or null if none exists.
 */
export function getAdjacentBlockClientId( state, startClientId, modifier = 1 ) {
	// Default to selected block.
	if ( startClientId === undefined ) {
		startClientId = getSelectedBlockClientId( state );
	}

	// Try multi-selection starting at extent based on modifier.
	if ( startClientId === undefined ) {
		if ( modifier < 0 ) {
			startClientId = getFirstMultiSelectedBlockClientId( state );
		} else {
			startClientId = getLastMultiSelectedBlockClientId( state );
		}
	}

	// Validate working start client ID.
	if ( ! startClientId ) {
		return null;
	}

	// Retrieve start block root client ID, being careful to allow the falsey
	// empty string top-level root by explicitly testing against null.
	const rootClientId = getBlockRootClientId( state, startClientId );
	if ( rootClientId === null ) {
		return null;
	}

	const { order } = state.editor.present.blocks;
	const orderSet = order[ rootClientId ];
	const index = orderSet.indexOf( startClientId );
	const nextIndex = ( index + ( 1 * modifier ) );

	// Block was first in set and we're attempting to get previous.
	if ( nextIndex < 0 ) {
		return null;
	}

	// Block was last in set and we're attempting to get next.
	if ( nextIndex === orderSet.length ) {
		return null;
	}

	// Assume incremented index is within the set.
	return orderSet[ nextIndex ];
}

/**
 * Returns the previous block's client ID from the given reference start ID.
 * Defaults start to the selected block. Returns null if there is no previous
 * block.
 *
 * @param {Object}  state         Editor state.
 * @param {?string} startClientId Optional client ID of block from which to
 *                                search.
 *
 * @return {?string} Adjacent block's client ID, or null if none exists.
 */
export function getPreviousBlockClientId( state, startClientId ) {
	return getAdjacentBlockClientId( state, startClientId, -1 );
}

/**
 * Returns the next block's client ID from the given reference start ID.
 * Defaults start to the selected block. Returns null if there is no next
 * block.
 *
 * @param {Object}  state         Editor state.
 * @param {?string} startClientId Optional client ID of block from which to
 *                                search.
 *
 * @return {?string} Adjacent block's client ID, or null if none exists.
 */
export function getNextBlockClientId( state, startClientId ) {
	return getAdjacentBlockClientId( state, startClientId, 1 );
}

/**
 * Returns the initial caret position for the selected block.
 * This position is to used to position the caret properly when the selected block changes.
 *
 * @param {Object} state Global application state.
 *
 * @return {?Object} Selected block.
 */
export function getSelectedBlocksInitialCaretPosition( state ) {
	const { start, end } = state.blockSelection;
	if ( start !== end || ! start ) {
		return null;
	}

	return state.blockSelection.initialPosition;
}

/**
 * Returns the current multi-selection set of block client IDs, or an empty
 * array if there is no multi-selection.
 *
 * @param {Object} state Editor state.
 *
 * @return {Array} Multi-selected block client IDs.
 */
export const getMultiSelectedBlockClientIds = createSelector(
	( state ) => {
		const { start, end } = state.blockSelection;
		if ( start === end ) {
			return [];
		}

		// Retrieve root client ID to aid in retrieving relevant nested block
		// order, being careful to allow the falsey empty string top-level root
		// by explicitly testing against null.
		const rootClientId = getBlockRootClientId( state, start );
		if ( rootClientId === null ) {
			return [];
		}

		const blockOrder = getBlockOrder( state, rootClientId );
		const startIndex = blockOrder.indexOf( start );
		const endIndex = blockOrder.indexOf( end );

		if ( startIndex > endIndex ) {
			return blockOrder.slice( endIndex, startIndex + 1 );
		}

		return blockOrder.slice( startIndex, endIndex + 1 );
	},
	( state ) => [
		state.editor.present.blocks.order,
		state.blockSelection.start,
		state.blockSelection.end,
	],
);

/**
 * Returns the current multi-selection set of blocks, or an empty array if
 * there is no multi-selection.
 *
 * @param {Object} state Editor state.
 *
 * @return {Array} Multi-selected block objects.
 */
export const getMultiSelectedBlocks = createSelector(
	( state ) => {
		const multiSelectedBlockClientIds = getMultiSelectedBlockClientIds( state );
		if ( ! multiSelectedBlockClientIds.length ) {
			return EMPTY_ARRAY;
		}

		return multiSelectedBlockClientIds.map( ( clientId ) => getBlock( state, clientId ) );
	},
	( state ) => [
		...getMultiSelectedBlockClientIds.getDependants( state ),
		state.editor.present.blocks,
		state.editor.present.edits.meta,
		state.initialEdits.meta,
		state.currentPost.meta,
	]
);

/**
 * Returns the client ID of the first block in the multi-selection set, or null
 * if there is no multi-selection.
 *
 * @param {Object} state Editor state.
 *
 * @return {?string} First block client ID in the multi-selection set.
 */
export function getFirstMultiSelectedBlockClientId( state ) {
	return first( getMultiSelectedBlockClientIds( state ) ) || null;
}

/**
 * Returns the client ID of the last block in the multi-selection set, or null
 * if there is no multi-selection.
 *
 * @param {Object} state Editor state.
 *
 * @return {?string} Last block client ID in the multi-selection set.
 */
export function getLastMultiSelectedBlockClientId( state ) {
	return last( getMultiSelectedBlockClientIds( state ) ) || null;
}

/**
 * Checks if possibleAncestorId is an ancestor of possibleDescendentId.
 *
 * @param {Object} state                Editor state.
 * @param {string} possibleAncestorId   Possible ancestor client ID.
 * @param {string} possibleDescendentId Possible descent client ID.
 *
 * @return {boolean} True if possibleAncestorId is an ancestor
 *                   of possibleDescendentId, and false otherwise.
 */
const isAncestorOf = createSelector(
	( state, possibleAncestorId, possibleDescendentId ) => {
		let idToCheck = possibleDescendentId;
		while ( possibleAncestorId !== idToCheck && idToCheck ) {
			idToCheck = getBlockRootClientId( state, idToCheck );
		}
		return possibleAncestorId === idToCheck;
	},
	( state ) => [
		state.editor.present.blocks.order,
	],
);

/**
 * Returns true if a multi-selection exists, and the block corresponding to the
 * specified client ID is the first block of the multi-selection set, or false
 * otherwise.
 *
 * @param {Object} state    Editor state.
 * @param {string} clientId Block client ID.
 *
 * @return {boolean} Whether block is first in multi-selection.
 */
export function isFirstMultiSelectedBlock( state, clientId ) {
	return getFirstMultiSelectedBlockClientId( state ) === clientId;
}

/**
 * Returns true if the client ID occurs within the block multi-selection, or
 * false otherwise.
 *
 * @param {Object} state    Editor state.
 * @param {string} clientId Block client ID.
 *
 * @return {boolean} Whether block is in multi-selection set.
 */
export function isBlockMultiSelected( state, clientId ) {
	return getMultiSelectedBlockClientIds( state ).indexOf( clientId ) !== -1;
}

/**
 * Returns true if an ancestor of the block is multi-selected, or false
 * otherwise.
 *
 * @param {Object} state    Editor state.
 * @param {string} clientId Block client ID.
 *
 * @return {boolean} Whether an ancestor of the block is in multi-selection
 *                   set.
 */
export const isAncestorMultiSelected = createSelector(
	( state, clientId ) => {
		let ancestorClientId = clientId;
		let isMultiSelected = false;
		while ( ancestorClientId && ! isMultiSelected ) {
			ancestorClientId = getBlockRootClientId( state, ancestorClientId );
			isMultiSelected = isBlockMultiSelected( state, ancestorClientId );
		}
		return isMultiSelected;
	},
	( state ) => [
		state.editor.present.blocks.order,
		state.blockSelection.start,
		state.blockSelection.end,
	],
);
/**
 * Returns the client ID of the block which begins the multi-selection set, or
 * null if there is no multi-selection.
 *
 * This is not necessarily the first client ID in the selection.
 *
 * @see getFirstMultiSelectedBlockClientId
 *
 * @param {Object} state Editor state.
 *
 * @return {?string} Client ID of block beginning multi-selection.
 */
export function getMultiSelectedBlocksStartClientId( state ) {
	const { start, end } = state.blockSelection;
	if ( start === end ) {
		return null;
	}
	return start || null;
}

/**
 * Returns the client ID of the block which ends the multi-selection set, or
 * null if there is no multi-selection.
 *
 * This is not necessarily the last client ID in the selection.
 *
 * @see getLastMultiSelectedBlockClientId
 *
 * @param {Object} state Editor state.
 *
 * @return {?string} Client ID of block ending multi-selection.
 */
export function getMultiSelectedBlocksEndClientId( state ) {
	const { start, end } = state.blockSelection;
	if ( start === end ) {
		return null;
	}
	return end || null;
}

/**
 * Returns an array containing all block client IDs in the editor in the order
 * they appear. Optionally accepts a root client ID of the block list for which
 * the order should be returned, defaulting to the top-level block order.
 *
 * @param {Object}  state        Editor state.
 * @param {?string} rootClientId Optional root client ID of block list.
 *
 * @return {Array} Ordered client IDs of editor blocks.
 */
export function getBlockOrder( state, rootClientId ) {
	return state.editor.present.blocks.order[ rootClientId || '' ] || EMPTY_ARRAY;
}

/**
 * Returns the index at which the block corresponding to the specified client
 * ID occurs within the block order, or `-1` if the block does not exist.
 *
 * @param {Object}  state        Editor state.
 * @param {string}  clientId     Block client ID.
 * @param {?string} rootClientId Optional root client ID of block list.
 *
 * @return {number} Index at which block exists in order.
 */
export function getBlockIndex( state, clientId, rootClientId ) {
	return getBlockOrder( state, rootClientId ).indexOf( clientId );
}

/**
 * Returns true if the block corresponding to the specified client ID is
 * currently selected and no multi-selection exists, or false otherwise.
 *
 * @param {Object} state    Editor state.
 * @param {string} clientId Block client ID.
 *
 * @return {boolean} Whether block is selected and multi-selection exists.
 */
export function isBlockSelected( state, clientId ) {
	const { start, end } = state.blockSelection;

	if ( start !== end ) {
		return false;
	}

	return start === clientId;
}

/**
 * Returns true if one of the block's inner blocks is selected.
 *
 * @param {Object}  state    Editor state.
 * @param {string}  clientId Block client ID.
 * @param {boolean} deep     Perform a deep check.
 *
 * @return {boolean} Whether the block as an inner block selected
 */
export function hasSelectedInnerBlock( state, clientId, deep = false ) {
	return some(
		getBlockOrder( state, clientId ),
		( innerClientId ) => (
			isBlockSelected( state, innerClientId ) ||
			isBlockMultiSelected( state, innerClientId ) ||
			( deep && hasSelectedInnerBlock( state, innerClientId, deep ) )
		)
	);
}

/**
 * Returns true if the block corresponding to the specified client ID is
 * currently selected but isn't the last of the selected blocks. Here "last"
 * refers to the block sequence in the document, _not_ the sequence of
 * multi-selection, which is why `state.blockSelection.end` isn't used.
 *
 * @param {Object} state    Editor state.
 * @param {string} clientId Block client ID.
 *
 * @return {boolean} Whether block is selected and not the last in the
 *                   selection.
 */
export function isBlockWithinSelection( state, clientId ) {
	if ( ! clientId ) {
		return false;
	}

	const clientIds = getMultiSelectedBlockClientIds( state );
	const index = clientIds.indexOf( clientId );
	return index > -1 && index < clientIds.length - 1;
}

/**
 * Returns true if a multi-selection has been made, or false otherwise.
 *
 * @param {Object} state Editor state.
 *
 * @return {boolean} Whether multi-selection has been made.
 */
export function hasMultiSelection( state ) {
	const { start, end } = state.blockSelection;
	return start !== end;
}

/**
 * Whether in the process of multi-selecting or not. This flag is only true
 * while the multi-selection is being selected (by mouse move), and is false
 * once the multi-selection has been settled.
 *
 * @see hasMultiSelection
 *
 * @param {Object} state Global application state.
 *
 * @return {boolean} True if multi-selecting, false if not.
 */
export function isMultiSelecting( state ) {
	return state.blockSelection.isMultiSelecting;
}

/**
 * Selector that returns if multi-selection is enabled or not.
 *
 * @param {Object} state Global application state.
 *
 * @return {boolean} True if it should be possible to multi-select blocks, false if multi-selection is disabled.
 */
export function isSelectionEnabled( state ) {
	return state.blockSelection.isEnabled;
}

/**
 * Returns the block's editing mode, defaulting to "visual" if not explicitly
 * assigned.
 *
 * @param {Object} state    Editor state.
 * @param {string} clientId Block client ID.
 *
 * @return {Object} Block editing mode.
 */
export function getBlockMode( state, clientId ) {
	return state.blocksMode[ clientId ] || 'visual';
}

/**
 * Returns true if the user is typing, or false otherwise.
 *
 * @param {Object} state Global application state.
 *
 * @return {boolean} Whether user is typing.
 */
export function isTyping( state ) {
	return state.isTyping;
}

/**
 * Returns true if the caret is within formatted text, or false otherwise.
 *
 * @param {Object} state Global application state.
 *
 * @return {boolean} Whether the caret is within formatted text.
 */
export function isCaretWithinFormattedText( state ) {
	return state.isCaretWithinFormattedText;
}

/**
 * Returns the insertion point, the index at which the new inserted block would
 * be placed. Defaults to the last index.
 *
 * @param {Object} state Editor state.
 *
 * @return {Object} Insertion point object with `rootClientId`, `index`.
 */
export function getBlockInsertionPoint( state ) {
	let rootClientId, index;

	const { insertionPoint, blockSelection } = state;
	if ( insertionPoint !== null ) {
		return insertionPoint;
	}

	const { end } = blockSelection;
	if ( end ) {
		rootClientId = getBlockRootClientId( state, end ) || undefined;
		index = getBlockIndex( state, end, rootClientId ) + 1;
	} else {
		index = getBlockOrder( state ).length;
	}

	return { rootClientId, index };
}

/**
 * Returns true if we should show the block insertion point.
 *
 * @param {Object} state Global application state.
 *
 * @return {?boolean} Whether the insertion point is visible or not.
 */
export function isBlockInsertionPointVisible( state ) {
	return state.insertionPoint !== null;
}

/**
 * Returns whether the blocks matches the template or not.
 *
 * @param {boolean} state
 * @return {?boolean} Whether the template is valid or not.
 */
export function isValidTemplate( state ) {
	return state.template.isValid;
}

/**
 * Returns the defined block template
 *
 * @param {boolean} state
 * @return {?Array}        Block Template
 */
export function getTemplate( state ) {
	return state.settings.template;
}

/**
 * Returns the defined block template lock. Optionally accepts a root block
 * client ID as context, otherwise defaulting to the global context.
 *
 * @param {Object}  state        Editor state.
 * @param {?string} rootClientId Optional block root client ID.
 *
 * @return {?string} Block Template Lock
 */
export function getTemplateLock( state, rootClientId ) {
	if ( ! rootClientId ) {
		return state.settings.templateLock;
	}

	const blockListSettings = getBlockListSettings( state, rootClientId );
	if ( ! blockListSettings ) {
		return null;
	}

	return blockListSettings.templateLock;
}

/**
 * Returns true if the post is currently being saved, or false otherwise.
 *
 * @param {Object} state Global application state.
 *
 * @return {boolean} Whether post is being saved.
 */
export function isSavingPost( state ) {
	return state.saving.requesting;
}

/**
 * Returns true if a previous post save was attempted successfully, or false
 * otherwise.
 *
 * @param {Object} state Global application state.
 *
 * @return {boolean} Whether the post was saved successfully.
 */
export function didPostSaveRequestSucceed( state ) {
	return state.saving.successful;
}

/**
 * Returns true if a previous post save was attempted but failed, or false
 * otherwise.
 *
 * @param {Object} state Global application state.
 *
 * @return {boolean} Whether the post save failed.
 */
export function didPostSaveRequestFail( state ) {
	return !! state.saving.error;
}

/**
 * Returns true if the post is autosaving, or false otherwise.
 *
 * @param {Object} state Global application state.
 *
 * @return {boolean} Whether the post is autosaving.
 */
export function isAutosavingPost( state ) {
	return isSavingPost( state ) && !! state.saving.options.isAutosave;
}

/**
 * Returns true if the post is being previewed, or false otherwise.
 *
 * @param {Object} state Global application state.
 *
 * @return {boolean} Whether the post is being previewed.
 */
export function isPreviewingPost( state ) {
	return isSavingPost( state ) && !! state.saving.options.isPreview;
}

/**
 * Returns the post preview link
 *
 * @param {Object} state Global application state.
 *
 * @return {string?} Preview Link.
 */
export function getEditedPostPreviewLink( state ) {
	const featuredImageId = getEditedPostAttribute( state, 'featured_media' );
	const previewLink = state.previewLink;
	if ( previewLink && featuredImageId ) {
		return addQueryArgs( previewLink, { _thumbnail_id: featuredImageId } );
	}

	return previewLink;
}

/**
 * Returns a suggested post format for the current post, inferred only if there
 * is a single block within the post and it is of a type known to match a
 * default post format. Returns null if the format cannot be determined.
 *
 * @param {Object} state Global application state.
 *
 * @return {?string} Suggested post format.
 */
export function getSuggestedPostFormat( state ) {
	const blocks = getBlockOrder( state );

	let name;
	// If there is only one block in the content of the post grab its name
	// so we can derive a suitable post format from it.
	if ( blocks.length === 1 ) {
		name = getBlockName( state, blocks[ 0 ] );
	}

	// If there are two blocks in the content and the last one is a text blocks
	// grab the name of the first one to also suggest a post format from it.
	if ( blocks.length === 2 ) {
		if ( getBlockName( state, blocks[ 1 ] ) === 'core/paragraph' ) {
			name = getBlockName( state, blocks[ 0 ] );
		}
	}

	// We only convert to default post formats in core.
	switch ( name ) {
		case 'core/image':
			return 'image';
		case 'core/quote':
		case 'core/pullquote':
			return 'quote';
		case 'core/gallery':
			return 'gallery';
		case 'core/video':
		case 'core-embed/youtube':
		case 'core-embed/vimeo':
			return 'video';
		case 'core/audio':
		case 'core-embed/spotify':
		case 'core-embed/soundcloud':
			return 'audio';
	}

	return null;
}

/**
 * Returns a set of blocks which are to be used in consideration of the post's
 * generated save content.
 *
 * @param {Object} state Editor state.
 *
 * @return {WPBlock[]} Filtered set of blocks for save.
 */
export function getBlocksForSerialization( state ) {
	const blocks = getBlocks( state );

	// A single unmodified default block is assumed to be equivalent to an
	// empty post.
	const isSingleUnmodifiedDefaultBlock = (
		blocks.length === 1 &&
		isUnmodifiedDefaultBlock( blocks[ 0 ] )
	);

	if ( isSingleUnmodifiedDefaultBlock ) {
		return [];
	}

	return blocks;
}

/**
 * Returns the content of the post being edited, preferring raw string edit
 * before falling back to serialization of block state.
 *
 * @param {Object} state Global application state.
 *
 * @return {string} Post content.
 */
export const getEditedPostContent = createSelector(
	( state ) => {
		const edits = getPostEdits( state );
		if ( 'content' in edits ) {
			return edits.content;
		}

		const blocks = getBlocksForSerialization( state );
		const content = serialize( blocks );

		// For compatibility purposes, treat a post consisting of a single
		// freeform block as legacy content and downgrade to a pre-block-editor
		// removep'd content format.
		const isSingleFreeformBlock = (
			blocks.length === 1 &&
			blocks[ 0 ].name === getFreeformContentHandlerName()
		);

		if ( isSingleFreeformBlock ) {
			return removep( content );
		}

		return content;
	},
	( state ) => [
		state.editor.present.blocks,
		state.editor.present.edits.content,
		state.initialEdits.content,
	],
);

/**
 * Determines if the given block type is allowed to be inserted into the block list.
 * This function is not exported and not memoized because using a memoized selector
 * inside another memoized selector is just a waste of time.
 *
 * @param {Object}  state        Editor state.
 * @param {string}  blockName    The name of the block type, e.g.' core/paragraph'.
 * @param {?string} rootClientId Optional root client ID of block list.
 *
 * @return {boolean} Whether the given block type is allowed to be inserted.
 */
const canInsertBlockTypeUnmemoized = ( state, blockName, rootClientId = null ) => {
	const checkAllowList = ( list, item, defaultResult = null ) => {
		if ( isBoolean( list ) ) {
			return list;
		}
		if ( isArray( list ) ) {
			return includes( list, item );
		}
		return defaultResult;
	};

	const blockType = getBlockType( blockName );
	if ( ! blockType ) {
		return false;
	}

	const { allowedBlockTypes } = getEditorSettings( state );

	const isBlockAllowedInEditor = checkAllowList( allowedBlockTypes, blockName, true );
	if ( ! isBlockAllowedInEditor ) {
		return false;
	}

	const isLocked = !! getTemplateLock( state, rootClientId );
	if ( isLocked ) {
		return false;
	}

	const parentBlockListSettings = getBlockListSettings( state, rootClientId );
	const parentAllowedBlocks = get( parentBlockListSettings, [ 'allowedBlocks' ] );
	const hasParentAllowedBlock = checkAllowList( parentAllowedBlocks, blockName );

	const blockAllowedParentBlocks = blockType.parent;
	const parentName = getBlockName( state, rootClientId );
	const hasBlockAllowedParent = checkAllowList( blockAllowedParentBlocks, parentName );

	if ( hasParentAllowedBlock !== null && hasBlockAllowedParent !== null ) {
		return hasParentAllowedBlock || hasBlockAllowedParent;
	} else if ( hasParentAllowedBlock !== null ) {
		return hasParentAllowedBlock;
	} else if ( hasBlockAllowedParent !== null ) {
		return hasBlockAllowedParent;
	}

	return true;
};

/**
 * Determines if the given block type is allowed to be inserted into the block list.
 *
 * @param {Object}  state        Editor state.
 * @param {string}  blockName    The name of the block type, e.g.' core/paragraph'.
 * @param {?string} rootClientId Optional root client ID of block list.
 *
 * @return {boolean} Whether the given block type is allowed to be inserted.
 */
export const canInsertBlockType = createSelector(
	canInsertBlockTypeUnmemoized,
	( state, blockName, rootClientId ) => [
		state.blockListSettings[ rootClientId ],
		state.editor.present.blocks.byClientId[ rootClientId ],
		state.settings.allowedBlockTypes,
		state.settings.templateLock,
	],
);

/**
 * Returns information about how recently and frequently a block has been inserted.
 *
 * @param {Object} state Global application state.
 * @param {string} id    A string which identifies the insert, e.g. 'core/block/12'
 *
 * @return {?{ time: number, count: number }} An object containing `time` which is when the last
 *                                            insert occured as a UNIX epoch, and `count` which is
 *                                            the number of inserts that have occurred.
 */
function getInsertUsage( state, id ) {
	return state.preferences.insertUsage[ id ] || null;
}

/**
 * Returns whether we can show a block type in the inserter
 *
 * @param {Object} state Global State
 * @param {Object} blockType BlockType
 * @param {?string} rootClientId Optional root client ID of block list.
 *
 * @return {boolean} Whether the given block type is allowed to be shown in the inserter.
 */
const canIncludeBlockTypeInInserter = ( state, blockType, rootClientId ) => {
	if ( ! hasBlockSupport( blockType, 'inserter', true ) ) {
		return false;
	}

	return canInsertBlockTypeUnmemoized( state, blockType.name, rootClientId );
};

/**
 * Returns whether we can show a reusable block in the inserter
 *
 * @param {Object} state Global State
 * @param {Object} reusableBlock Reusable block object
 * @param {?string} rootClientId Optional root client ID of block list.
 *
 * @return {boolean} Whether the given block type is allowed to be shown in the inserter.
 */
const canIncludeReusableBlockInInserter = ( state, reusableBlock, rootClientId ) => {
	if ( ! canInsertBlockTypeUnmemoized( state, 'core/block', rootClientId ) ) {
		return false;
	}

	const referencedBlockName = getBlockName( state, reusableBlock.clientId );
	if ( ! referencedBlockName ) {
		return false;
	}

	const referencedBlockType = getBlockType( referencedBlockName );
	if ( ! referencedBlockType ) {
		return false;
	}

	if ( ! canInsertBlockTypeUnmemoized( state, referencedBlockName, rootClientId ) ) {
		return false;
	}

	if ( isAncestorOf( state, reusableBlock.clientId, rootClientId ) ) {
		return false;
	}

	return true;
};

/**
 * Determines the items that appear in the inserter. Includes both static
 * items (e.g. a regular block type) and dynamic items (e.g. a reusable block).
 *
 * Each item object contains what's necessary to display a button in the
 * inserter and handle its selection.
 *
 * The 'utility' property indicates how useful we think an item will be to the
 * user. There are 4 levels of utility:
 *
 * 1. Blocks that are contextually useful (utility = 3)
 * 2. Blocks that have been previously inserted (utility = 2)
 * 3. Blocks that are in the common category (utility = 1)
 * 4. All other blocks (utility = 0)
 *
 * The 'frecency' property is a heuristic (https://en.wikipedia.org/wiki/Frecency)
 * that combines block usage frequenty and recency.
 *
 * Items are returned ordered descendingly by their 'utility' and 'frecency'.
 *
 * @param {Object}  state        Editor state.
 * @param {?string} rootClientId Optional root client ID of block list.
 *
 * @return {Editor.InserterItem[]} Items that appear in inserter.
 *
 * @typedef {Object} Editor.InserterItem
 * @property {string}   id                Unique identifier for the item.
 * @property {string}   name              The type of block to create.
 * @property {Object}   initialAttributes Attributes to pass to the newly created block.
 * @property {string}   title             Title of the item, as it appears in the inserter.
 * @property {string}   icon              Dashicon for the item, as it appears in the inserter.
 * @property {string}   category          Block category that the item is associated with.
 * @property {string[]} keywords          Keywords that can be searched to find this item.
 * @property {boolean}  isDisabled        Whether or not the user should be prevented from inserting
 *                                        this item.
 * @property {number}   utility           How useful we think this item is, between 0 and 3.
 * @property {number}   frecency          Hueristic that combines frequency and recency.
 */
export const getInserterItems = createSelector(
	( state, rootClientId = null ) => {
		const calculateUtility = ( category, count, isContextual ) => {
			if ( isContextual ) {
				return INSERTER_UTILITY_HIGH;
			} else if ( count > 0 ) {
				return INSERTER_UTILITY_MEDIUM;
			} else if ( category === 'common' ) {
				return INSERTER_UTILITY_LOW;
			}
			return INSERTER_UTILITY_NONE;
		};

		const calculateFrecency = ( time, count ) => {
			if ( ! time ) {
				return count;
			}

			// The selector is cached, which means Date.now() is the last time that the
			// relevant state changed. This suits our needs.
			const duration = Date.now() - time;

			switch ( true ) {
				case duration < MILLISECONDS_PER_HOUR:
					return count * 4;
				case duration < MILLISECONDS_PER_DAY:
					return count * 2;
				case duration < MILLISECONDS_PER_WEEK:
					return count / 2;
				default:
					return count / 4;
			}
		};

		const buildBlockTypeInserterItem = ( blockType ) => {
			const id = blockType.name;

			let isDisabled = false;
			if ( ! hasBlockSupport( blockType.name, 'multiple', true ) ) {
				isDisabled = some( getBlocksByClientId( state, getClientIdsWithDescendants( state ) ), { name: blockType.name } );
			}

			const isContextual = isArray( blockType.parent );
			const { time, count = 0 } = getInsertUsage( state, id ) || {};

			return {
				id,
				name: blockType.name,
				initialAttributes: {},
				title: blockType.title,
				icon: blockType.icon,
				category: blockType.category,
				keywords: blockType.keywords,
				isDisabled,
				utility: calculateUtility( blockType.category, count, isContextual ),
				frecency: calculateFrecency( time, count ),
				hasChildBlocksWithInserterSupport: hasChildBlocksWithInserterSupport( blockType.name ),
			};
		};

		const buildReusableBlockInserterItem = ( reusableBlock ) => {
			const id = `core/block/${ reusableBlock.id }`;

			const referencedBlockName = getBlockName( state, reusableBlock.clientId );
			const referencedBlockType = getBlockType( referencedBlockName );

			const { time, count = 0 } = getInsertUsage( state, id ) || {};
			const utility = calculateUtility( 'reusable', count, false );
			const frecency = calculateFrecency( time, count );

			return {
				id,
				name: 'core/block',
				initialAttributes: { ref: reusableBlock.id },
				title: reusableBlock.title,
				icon: referencedBlockType.icon,
				category: 'reusable',
				keywords: [],
				isDisabled: false,
				utility,
				frecency,
			};
		};

		const blockTypeInserterItems = getBlockTypes()
			.filter( ( blockType ) => canIncludeBlockTypeInInserter( state, blockType, rootClientId ) )
			.map( buildBlockTypeInserterItem );

		const reusableBlockInserterItems = __experimentalGetReusableBlocks( state )
			.filter( ( block ) => canIncludeReusableBlockInInserter( state, block, rootClientId ) )
			.map( buildReusableBlockInserterItem );

		return orderBy(
			[ ...blockTypeInserterItems, ...reusableBlockInserterItems ],
			[ 'utility', 'frecency' ],
			[ 'desc', 'desc' ]
		);
	},
	( state, rootClientId ) => [
		state.blockListSettings[ rootClientId ],
		state.editor.present.blocks.byClientId,
		state.editor.present.blocks.order,
		state.preferences.insertUsage,
		state.settings.allowedBlockTypes,
		state.settings.templateLock,
		state.reusableBlocks.data,
		getBlockTypes(),
	],
);

/**
 * Determines whether there are items to show in the inserter.
 * @param {Object}  state        Editor state.
 * @param {?string} rootClientId Optional root client ID of block list.
 *
 * @return {boolean} Items that appear in inserter.
 */
export const hasInserterItems = createSelector(
	( state, rootClientId = null ) => {
		const hasBlockType = some(
			getBlockTypes(),
			( blockType ) => canIncludeBlockTypeInInserter( state, blockType, rootClientId )
		);
		if ( hasBlockType ) {
			return true;
		}
		const hasReusableBlock = some(
			__experimentalGetReusableBlocks( state ),
			( block ) => canIncludeReusableBlockInInserter( state, block, rootClientId )
		);

		return hasReusableBlock;
	},
	( state, rootClientId ) => [
		state.blockListSettings[ rootClientId ],
		state.editor.present.blocks.byClientId,
		state.settings.allowedBlockTypes,
		state.settings.templateLock,
		state.reusableBlocks.data,
		getBlockTypes(),
	],
);

/**
 * Returns the reusable block with the given ID.
 *
 * @param {Object}        state Global application state.
 * @param {number|string} ref   The reusable block's ID.
 *
 * @return {Object} The reusable block, or null if none exists.
 */
export const __experimentalGetReusableBlock = createSelector(
	( state, ref ) => {
		const block = state.reusableBlocks.data[ ref ];
		if ( ! block ) {
			return null;
		}

		const isTemporary = isNaN( parseInt( ref ) );

		return {
			...block,
			id: isTemporary ? ref : +ref,
			isTemporary,
		};
	},
	( state, ref ) => [
		state.reusableBlocks.data[ ref ],
	],
);

/**
 * Returns whether or not the reusable block with the given ID is being saved.
 *
 * @param {Object} state Global application state.
 * @param {string} ref   The reusable block's ID.
 *
 * @return {boolean} Whether or not the reusable block is being saved.
 */
export function __experimentalIsSavingReusableBlock( state, ref ) {
	return state.reusableBlocks.isSaving[ ref ] || false;
}

/**
 * Returns true if the reusable block with the given ID is being fetched, or
 * false otherwise.
 *
 * @param {Object} state Global application state.
 * @param {string} ref   The reusable block's ID.
 *
 * @return {boolean} Whether the reusable block is being fetched.
 */
export function __experimentalIsFetchingReusableBlock( state, ref ) {
	return !! state.reusableBlocks.isFetching[ ref ];
}

/**
 * Returns an array of all reusable blocks.
 *
 * @param {Object} state Global application state.
 *
 * @return {Array} An array of all reusable blocks.
 */
export function __experimentalGetReusableBlocks( state ) {
	return map(
		state.reusableBlocks.data,
		( value, ref ) => __experimentalGetReusableBlock( state, ref )
	);
}

/**
 * Returns state object prior to a specified optimist transaction ID, or `null`
 * if the transaction corresponding to the given ID cannot be found.
 *
 * @param {Object} state         Current global application state.
 * @param {Object} transactionId Optimist transaction ID.
 *
 * @return {Object} Global application state prior to transaction.
 */
export function getStateBeforeOptimisticTransaction( state, transactionId ) {
	const transaction = find( state.optimist, ( entry ) => (
		entry.beforeState &&
		get( entry.action, [ 'optimist', 'id' ] ) === transactionId
	) );

	return transaction ? transaction.beforeState : null;
}

/**
 * Returns true if the post is being published, or false otherwise.
 *
 * @param {Object} state Global application state.
 *
 * @return {boolean} Whether post is being published.
 */
export function isPublishingPost( state ) {
	if ( ! isSavingPost( state ) ) {
		return false;
	}

	// Saving is optimistic, so assume that current post would be marked as
	// published if publishing
	if ( ! isCurrentPostPublished( state ) ) {
		return false;
	}

	// Use post update transaction ID to retrieve the state prior to the
	// optimistic transaction
	const stateBeforeRequest = getStateBeforeOptimisticTransaction(
		state,
		POST_UPDATE_TRANSACTION_ID
	);

	// Consider as publishing when current post prior to request was not
	// considered published
	return !! stateBeforeRequest && ! isCurrentPostPublished( stateBeforeRequest );
}

/**
 * Returns whether the permalink is editable or not.
 *
 * @param {Object} state Editor state.
 *
 * @return {boolean} Whether or not the permalink is editable.
 */
export function isPermalinkEditable( state ) {
	const permalinkTemplate = getEditedPostAttribute( state, 'permalink_template' );

	return PERMALINK_POSTNAME_REGEX.test( permalinkTemplate );
}

/**
 * Returns the permalink for the post.
 *
 * @param {Object} state Editor state.
 *
 * @return {?string} The permalink, or null if the post is not viewable.
 */
export function getPermalink( state ) {
	const permalinkParts = getPermalinkParts( state );
	if ( ! permalinkParts ) {
		return null;
	}

	const { prefix, postName, suffix } = permalinkParts;

	if ( isPermalinkEditable( state ) ) {
		return prefix + postName + suffix;
	}

	return prefix;
}

/**
 * Returns the permalink for a post, split into it's three parts: the prefix,
 * the postName, and the suffix.
 *
 * @param {Object} state Editor state.
 *
 * @return {Object} An object containing the prefix, postName, and suffix for
 *                  the permalink, or null if the post is not viewable.
 */
export function getPermalinkParts( state ) {
	const permalinkTemplate = getEditedPostAttribute( state, 'permalink_template' );
	if ( ! permalinkTemplate ) {
		return null;
	}

	const postName = getEditedPostAttribute( state, 'slug' ) || getEditedPostAttribute( state, 'generated_slug' );

	const [ prefix, suffix ] = permalinkTemplate.split( PERMALINK_POSTNAME_REGEX );

	return {
		prefix,
		postName,
		suffix,
	};
}

/**
 * Returns true if an optimistic transaction is pending commit, for which the
 * before state satisfies the given predicate function.
 *
 * @param {Object}   state     Editor state.
 * @param {Function} predicate Function given state, returning true if match.
 *
 * @return {boolean} Whether predicate matches for some history.
 */
export function inSomeHistory( state, predicate ) {
	const { optimist } = state;

	// In recursion, optimist state won't exist. Assume exhausted options.
	if ( ! optimist ) {
		return false;
	}

	return optimist.some( ( { beforeState } ) => (
		beforeState && predicate( beforeState )
	) );
}

/**
 * Returns the Block List settings of a block, if any exist.
 *
 * @param {Object}  state    Editor state.
 * @param {?string} clientId Block client ID.
 *
 * @return {?Object} Block settings of the block if set.
 */
export function getBlockListSettings( state, clientId ) {
	return state.blockListSettings[ clientId ];
}

/**
 * Returns the editor settings.
 *
 * @param {Object} state Editor state.
 *
 * @return {Object} The editor settings object.
 */
export function getEditorSettings( state ) {
	return state.settings;
}

/**
 * Returns the token settings.
 *
 * @param {Object} state Editor state.
 * @param {?string} name Token name.
 *
 * @return {Object} Token settings object, or the named token settings object if set.
 */
export function getTokenSettings( state, name ) {
	if ( ! name ) {
		return state.tokens;
	}

	return state.tokens[ name ];
}

/**
 * Returns whether the post is locked.
 *
 * @param {Object} state Global application state.
 *
 * @return {boolean} Is locked.
 */
export function isPostLocked( state ) {
	return state.postLock.isLocked;
}

/**
 * Returns whether post saving is locked.
 *
 * @param {Object} state Global application state.
 *
 * @return {boolean} Is locked.
 */
export function isPostSavingLocked( state ) {
	return Object.keys( state.postSavingLock ).length > 0;
}

/**
 * Returns whether the edition of the post has been taken over.
 *
 * @param {Object} state Global application state.
 *
 * @return {boolean} Is post lock takeover.
 */
export function isPostLockTakeover( state ) {
	return state.postLock.isTakeover;
}

/**
 * Returns details about the post lock user.
 *
 * @param {Object} state Global application state.
 *
 * @return {Object} A user object.
 */
export function getPostLockUser( state ) {
	return state.postLock.user;
}

/**
 * Returns the active post lock.
 *
 * @param {Object} state Global application state.
 *
 * @return {Object} The lock object.
 */
export function getActivePostLock( state ) {
	return state.postLock.activePostLock;
}

/**
 * Returns whether or not the user has the unfiltered_html capability.
 *
 * @param {Object} state Editor state.
 *
 * @return {boolean} Whether the user can or can't post unfiltered HTML.
 */
export function canUserUseUnfilteredHTML( state ) {
	return has( getCurrentPost( state ), [ '_links', 'wp:action-unfiltered-html' ] );
}

/**
 * Returns whether the pre-publish panel should be shown
 * or skipped when the user clicks the "publish" button.
 *
 * @param {Object} state Global application state.
 *
 * @return {boolean} Whether the pre-publish panel should be shown or not.
 */
export function isPublishSidebarEnabled( state ) {
	if ( state.preferences.hasOwnProperty( 'isPublishSidebarEnabled' ) ) {
		return state.preferences.isPublishSidebarEnabled;
	}
	return PREFERENCES_DEFAULTS.isPublishSidebarEnabled;
}
