
//==================================================//
// rollbackgameengine/components/removedafter.js
// todo - add max ttl bit size to type
//==================================================//

rollbackgameengine.components.removedAfter = {
	loadType : function(type, options) {
		//add default properties
		type._maxttl = options.frames;

		//save bit size
		type._ttlBitSize = rollbackgameengine.networking.calculateUnsignedIntegerBitSize(type._maxttl);
	},

	loadEntity : function(entity, options) {
		//add default properties
		entity._ttl = options.frame;
	},

	addedToWorld : function(entity) {
		//reset ttl
		entity._ttl = entity.type._maxttl;
	},

	update : function(entity) {
		//decrement
		entity._ttl--;

		//remove
		if(entity._ttl <= 0) {
			entity.world.recycleEntity(entity);
		}
	},
	
	rollback : function(entity1, entity2) {
		//rollback values
		entity1._ttl = entity2._ttl;
	},

	encode : function(entity, outgoingMessage) {
		outgoingMessage.addUnsignedInteger(entity._ttl, entity.type._ttlBitSize);
	},

	decode : function(entity, incomingMessage) {
		entity._ttl = incomingMessage.nextUnsignedInteger(entity.type._ttlBitSize);
	}
}
