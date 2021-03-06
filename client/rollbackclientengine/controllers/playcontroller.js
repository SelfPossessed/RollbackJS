
//==================================================//
// controllers/playcontroller.js
//
// controlling start time - how should this be handled?
// should it be handled by a separate object before playcontroller and then the connection passed in?
// or should the playcontroller do it?
//
// for now just don't have that system, just use the immediate start
// figure it out later
//
// todo - restructure class again to use more _ for private functions
//
//==================================================//

//eventually pass canvas container in here
//get width and height from game world
//need to obtain width and height to determine max sync value
//frame delay must be between 0 and 127 inclusive
//url, Factory, Command, frameRate, frameDelay, playerCount, minimumUpdateFrame, frameSkipBitSize
rollbackclientengine.controllers.PlayController = function(options) {

//LOGGING

	//debug logging
	this.framesSkipped = 0;
	this.message = "Waiting for another player...";
	this.displayedMessage = false;

//DEFAULTS

	//frame rate default
	if(typeof options.frameRate === 'undefined') {
		options.frameRate = 33; //33
	}

	//frame delay default
	if(typeof options.frameDelay === 'undefined') {
		options.frameDelay = 2; //2
	}

	//player count default
	if(typeof options.playerCount === 'undefined') {
		options.playerCount = 2;
	}

	//minimum update frame default
	if(typeof options.minimumUpdateFrame === 'undefined') {
		options.minimumUpdateFrame = 1;
	}

//GAME

	//commands
	this.CommandObject = options.Command;
	rollbackgameengine.giveID(this.CommandObject); //id for pooling usage on the object itself
	this.outgoingCommand = this._getNewCommand(); //modified by player inputs

	//worlds
	this.trueWorld = new options.factory.create();
	this.perceivedWorld = new options.factory.create();

	//player count - if use default 2, doesn't store player
	this.shouldSendPlayer = options.playerCount > 2;
	this.playerCount = options.playerCount;
	if(this.shouldSendPlayer) {
		//todo - calculate bit size
		this.sendPlayerBitSize = null;
	}

	//players
	this.players = [];
	for(var i=0; i<this.playerCount; i++) {
		//populate array
		this.players[i] = new rollbackclientengine.controllers.PlayController.Player();
	}
	this.player = null; //will be set by server
	if(!this.shouldSendPlayer) {
		this.enemyPlayer = null; //will be set by server
	}

//FRAMES AND TIMING

	//minimum update frame - if use default 1, doesn't store frame #
	if(options.minimumUpdateFrame === 1) {
		this.shouldSendFrame = false;
	}else {
		//store values
		this.shouldSendFrame = true;
		this.minimumUpdateFrame = options.minimumUpdateFrame;
	}

	//frame delay
	this.frameDelay = options.frameDelay + 1;

	//frame rate
	this.frameRate = options.frameRate;

	//frame difference - # between perceived updates
	this.frameDifference = 0;

	//received frame difference - # frames between true world and received command
	if(this.shouldSendPlayer) {
		//1 per player
	}else {
		//just 1 for the other player
		this.receivedFrameDifference = 0;
	}

	//perceived frame difference - # frames between true world and perceived world
	this.perceivedFrameDifference = 0;

	//sync frame difference - # frames between true world and last sync value
	this.syncFrameDifference = 0;

	//timing
	this.currentTime = null;
	this.nextFrameTime = null;

	//counter
	this.frameCounter = 0;

//GENERAL

	//started
	this.started = false;

	//rollback
	this.shouldRollback = false;

	//render
	this.shouldRender = false;

//NETWORKING

	//frameSkipBitSize
	if(options.frameSkipBitSize && options.frameSkipBitSize !== rollbackgameengine.networking.variableLengthEncodeBitSize) {
		this.frameSkipBitSize = options.frameSkipBitSize;
	}

	//byte size - used to acquire outgoing message from pool or create it
	this.outgoingByteSize = this.outgoingCommand.totalBitSize + 1;
	if(this.frameSkipBitSize) {
		this.outgoingByteSize += this.frameSkipBitSize;
	}else {
		this.outgoingByteSize += rollbackgameengine.networking.variableLengthEncodeBitSize;
	}
	this.outgoingByteSize /= 8;
	this.outgoingByteSize = Math.ceil(this.outgoingByteSize);

	//sync
	this.syncFrameRate = options.syncFrameRate;
	this.syncFrameRateBitSize = rollbackgameengine.networking.calculateUnsignedIntegerBitSize(this.syncFrameRate);
	this.syncCalc = new rollbackgameengine.sync.SyncCalculator();
	this.serverSyncValues = new rollbackgameengine.datastructures.SinglyLinkedList();
	this.clientSyncValues = new rollbackgameengine.datastructures.SinglyLinkedList();
	this.requestDump = false; //if true, time to send request
	this.dumpRequested = false; //request made, waiting for response

	//connection
	this.connection = new rollbackclientengine.Connection();
	this.connection.connect(options.url);
	this.connection.delegate = this;
	this.connection.onConnect = function() { this.delegate._onConnect.call(this.delegate) };
	this.connection.onReceivedText = function(t) { this.delegate._onReceivedText.call(this.delegate, t) };
	this.connection.onReceivedData = function(m) { this.delegate._onReceivedData.call(this.delegate, m) };
	this.connection.onDisconnect = function(m) { this.delegate._onDisconnect.call(this.delegate) };
};

//player

rollbackclientengine.controllers.PlayController.Player = function() {
	this.commands = new rollbackgameengine.datastructures.SinglyLinkedList();
	this.trueCommand = null;
	this.perceivedCommand = null;
	this.receivedFrameDifference = null; //todo - make it work with frame rework AND for multiple players
}

//sync

rollbackclientengine.controllers.PlayController.prototype._poolCommands = function() {
	//declare variables
	var cmd = null;
	var p = null;

	//loop
	for(var i=0; i<this.playerCount; i++) {
		//get player
		p = this.players[i];

		for(var j=0; j<this.syncFrameRate; j++) {
			//true
			if(p.commands.head === p.trueCommand) {
				p.trueCommand = null;
			}

			//perceived
			if(p.commands.head === p.perceivedCommand) {
				p.perceivedCommand = null;
				this.shouldRollback = true;
			}

			//pop and pool
			rollbackgameengine.pool.add(this.CommandObject, p.commands.pop());
		}
	}
};

rollbackclientengine.controllers.PlayController.prototype._syncClient = function(syncValue) {
	console.log("calculated sync value for " + this.trueWorld.frame + " to be " + syncValue);

	//declare variables
	var compare = this.serverSyncValues.pop();

	if(compare) {
		//check sync
		if(!this.dumpRequested && syncValue !== -1 && compare !== syncValue) {
			//request
			this.requestDump = true;
			console.log("request dump true should be " + compare);
		}

		//pool commands
		this._poolCommands();
	}else {
		//add to list
		this.clientSyncValues.add(syncValue);
	}
};

rollbackclientengine.controllers.PlayController.prototype._syncServer = function(syncValue) {
	//valid check
	if(!syncValue) {
		return;
	}

	//increment sync frame difference
	this.syncFrameDifference += this.syncFrameRate;

	//declare variables
	var compare = this.clientSyncValues.pop();

	if(compare >= 1) {
		//check sync
		if(!this.dumpRequested && compare !== -1 && compare !== syncValue) {
			//request
			this.requestDump = true;
			console.log("request dump true should be " + compare);
		}

		//pool commands
		this._poolCommands();
	}else {
		//add to list
		this.serverSyncValues.add(syncValue);
	}
};

rollbackclientengine.controllers.PlayController.prototype._syncCheckAfterTrueWorldUpdate = function() {
	//decrement frame differences
	this.perceivedFrameDifference--;
	this.receivedFrameDifference--;
	this.syncFrameDifference--;

	//increment counter
	this.frameCounter++;

	//sync
	if(this.frameCounter === this.syncFrameRate) {
		//reset counter
		this.frameCounter = 0;

		//sync value
		if(!this.dumpRequested) {
			//actual sync
			this.trueWorld.encode(this.syncCalc);
	 		this._syncClient(this.syncCalc.calculateSyncValue());
		}else {
			//dummy
			this._syncClient(-1);
		}
	}
}

//updates
rollbackclientengine.controllers.PlayController.prototype._updateTrueWorld = function() {
	//todo - command lookahead check

	//valid check
	if(this.dumpRequested || this.requestDump) {
		return;
	}

	//declare variables
	var leastDifference = null;

	//determine frame to loop to
	if(this.shouldSendPlayer) {
		//todo get the least of all the player frames and set to least frame
	}else {
		leastDifference = Math.min(this.receivedFrameDifference, this.perceivedFrameDifference);
	}

	//determine should update true
	if(leastDifference <= 0) {
		return;
	}

	//declare variables
	var p = null;
	var c = null;

	//loop update true
	do {
		//loop through player commands
		for(var i=0; i<this.playerCount; i++) {
			//get player
			p = this.players[i];

			//get command node
			c = p.trueCommand;
			if(!c) {
				//set command to head
				c = p.commands.head;
			}else {
				//increment command
				c = c.next;
			}

			//check command exists
			if(this.shouldSendFrame) {
				//todo - check against frame and handle if command does not exist

				continue;
			}else if(!c) {
				//todo - remove this temporary check that shouldn't be needed
				alert("p" + this.player + " tf" + this.trueWorld.frame + " > wtf no true command for " + i + " in 2 player mode?");
				continue;
			}

			//execute command
			this.trueWorld.execute(i, c.obj);

			//increment true command
			p.trueCommand = c;
		}

		//update true world
		this.trueWorld.update();
		this._syncCheckAfterTrueWorldUpdate();

		//decrement
		leastDifference--;
	}while(leastDifference > 0);

	//determine needed
	if(!this.shouldRollback) {
		//exit
		return;
	}else {
		//reset
		this.shouldRollback = false;
	}

	//rollback worlds
	this.perceivedWorld.rollback(this.trueWorld);

	//rollback command positions
	for(var i=0; i<this.playerCount; i++) {
		this.players[i].perceivedCommand = this.players[i].trueCommand;
	}

	//loop update perceived back to current
	while(this.perceivedFrameDifference > 0) {
		//loop through player commands
		for(var i=0; i<this.playerCount; i++) {
			//get player
			p = this.players[i];

			//get command node
			c = p.perceivedCommand;
			if(!c) {
				//set command to head
				c = p.commands.head;
			}else {
				//increment command
				c = c.next;
			}

			//check command exists
			if(this.shouldSendFrame) {
				//todo - check against frame and handle if command does not exist

				//skip
				continue;
			}else if(!c) {
				//skip
				continue;
			}

			//execute command
			this.perceivedWorld.execute(i, c.obj);

			//increment perceived command
			p.perceivedCommand = c;
		}

		//update perceived world
		this.perceivedWorld.update();

		//decrement
		this.perceivedFrameDifference--;
	}
};

rollbackclientengine.controllers.PlayController.prototype._updatePerceivedWorld = function() {
	//todo - command look ahead check

	//valid check
	if(this.currentTime < this.nextFrameTime) {
		return;
	}

	//set boolean
	this.shouldRender = true;

	//declare variables
	var p = null;
	var c = null;

	//loop update perceived
	do {
		//loop through player commands
		for(var i=0; i<this.playerCount; i++) {
			//get player
			p = this.players[i];

			//get command node
			c = p.perceivedCommand;
			if(!c) {
				//set command to head
				c = p.commands.head;
			}else {
				//increment command
				c = c.next;
			}

			//check command exists
			if(this.shouldSendFrame) {
				//todo - check against frame and handle if command does not exist

				//skip
				continue;
			}else if(!c) {
				//set boolean
				this.shouldRollback = true;

				//skip
				continue;
			}

			//execute command
			this.perceivedWorld.execute(i, c.obj);

			//increment perceived command
			p.perceivedCommand = c;
		}

		//update perceived world
		this.perceivedWorld.update();

		//increment perceived frame difference
		this.perceivedFrameDifference++;

		//increment next frame time
		this.nextFrameTime += this.frameRate;

		//increment frame difference
		this.frameDifference++;
	}while(this.currentTime >= this.nextFrameTime);
};

rollbackclientengine.controllers.PlayController.prototype._sendInputs = function() {
	//valid check
	if(!this.shouldRender) {
		return;
	}

	//declare variables
	var message = null;
	var skipped = this.frameDifference-1;

	if(skipped > 0) {
		//frame was skipped

		//calculate byte size
		var byteSize = Math.ceil((this.outgoingCommand.totalBitSize + 1 + rollbackgameengine.networking.calculateUnsignedIntegerBitSize(skipped))/8);

		//get message
		message = rollbackgameengine.pool.acquire("msg"+byteSize);
		if(message) {
			//reset pooled
			message.reset();
		}else {
			//new
			message = new rollbackgameengine.networking.OutgoingMessage(byteSize);
		}
	}else {
		//no frames skipped

		//get message
		message = rollbackgameengine.pool.acquire("msg"+this.outgoingByteSize);
		if(message) {
			//reset pooled
			message.reset();
		}else {
			//new
			message = new rollbackgameengine.networking.OutgoingMessage(this.outgoingByteSize);
		}
	}

	//create command
	var c = this._getNewCommand();
	c.loadFromCommand(this.outgoingCommand);

	//set frame
	if(this.shouldSendFrame) {
		//todo - take frame difference and calculate actual frame
	}

	//store command
	this.player.commands.add(c);

	//duplicate command
	if(!this.shouldSendFrame) {
		//loop
		for(var i=1; i<this.frameDifference; i++) {
			//create command
			c = this._getNewCommand();
			c.loadFromCommand(this.outgoingCommand);

			//store command
			this.player.commands.add(c);
		}
	}

	//append dump request
	if(this.requestDump) {
		console.log("dump requested");
		this.requestDump = false;
		this.dumpRequested = true;
		message.addBoolean(true);
	}else {
		message.addBoolean(false);
	}

	//append command data to message
	c.addDataToMessage(message);

	//append frame skip
	message.addFinalUnsignedInteger(skipped);

	//send message
	this.connection.send(message);

	//pool message
	rollbackgameengine.pool.add("msg"+message.byteSize, message);
};

rollbackclientengine.controllers.PlayController.prototype.update = function() {
	//valid check
	if(!this.started) {
		return;
	}

	//reset frame difference
	this.frameDifference = 0;

	//current time
	this.currentTime = Date.now();

	//updates
	this._updateTrueWorld();
	this._updatePerceivedWorld();
	this._sendInputs();
};

//render

rollbackclientengine.controllers.PlayController.prototype.render = function(canvas) {
	//valid
	if(!this.started) {
		//debug
		if(!this.displayedMessage) {
			this.displayedMessage = true;
			var ctx = canvas.getContext("2d");
			ctx.clearRect(0, 0, canvas.width, canvas.height);
			ctx.font = "normal 36px Verdana";
			ctx.fillStyle = "#FFFFFF";
			ctx.fillText(this.message, 50, 50);
		}

		//return
		return;
	}

	//should this function do the clearing?
	//if so, how do I get the height and width?
	//what if I pass in canvas here?
	//is getting the ctx every time too slow?
	//for now just let someone else clear it
	//handle the clearing later

	//get context
	var ctx = canvas.getContext("2d");

	//render check
	if(this.shouldRender) {
		//clear
		ctx.clearRect(0, 0, canvas.width, canvas.height);

		//render
		this.trueWorld.render(ctx); //debug
		//this.perceivedWorld.render(ctx);

		//debug
		if(this.frameDifference > 1) {
			this.framesSkipped += (this.frameDifference-1);
		}
		ctx.font = "normal 36px Verdana";
		ctx.fillStyle = "#FFFFFF";
		ctx.fillText(this.framesSkipped + " frames skipped!!", 50, 50);
	}
	this.shouldRender = false;
};

//connection

rollbackclientengine.controllers.PlayController.prototype._onConnect = function() {
	//todo - allow ready message to have customizable properties, like selecting character

	//send ready message
	var readyMessage = new rollbackgameengine.networking.OutgoingMessage(1);
	readyMessage.addUnsignedInteger(this.frameDelay, 7);
	this.connection.send(readyMessage);

	//add to pool
	rollbackgameengine.pool.add("msg1", readyMessage);
};

rollbackclientengine.controllers.PlayController.prototype._onReceivedText = function(text) {
	//todo - chat
};

rollbackclientengine.controllers.PlayController.prototype._onReceivedData = function(incomingMessage) {
	//declare variables
	var c = null;

	if(!this.started) {
		//start command

		//set player - todo - determine bit size based on player count
		var pid = incomingMessage.nextUnsignedInteger(1);
		this.player = this.players[pid];

		//deal with frame delay
		if(!this.shouldSendFrame) {
			if(this.shouldSendPlayer) {
				//todo - delay for multiple players
			}else {
				//set enemy player
				if(pid === 0) {
					this.enemyPlayer = this.players[1];
				}else {
					this.enemyPlayer = this.players[0];
				}

				//your default commands
				for(var i=0; i<this.frameDelay; i++) {
					//create command
					c = this._getNewCommand();

					//add command
					this.player.commands.add(c);
				}

				//delay
				var enemyDelay = incomingMessage.nextUnsignedInteger(7);

				//last received frame
				this.receivedFrameDifference = enemyDelay-1;

				//default enemy commands
				for(var i=0, j=enemyDelay; i<j; i++) {
					//create command
					c = this._getNewCommand();

					//add
					this.enemyPlayer.commands.add(c);
				}
			}
		}

		//set next frame time
		this.nextFrameTime = Date.now() + this.frameRate;

		//set started
		this.started = true;
	}else {
		//game command

		//parse player
		if(this.shouldSendPlayer) {
			//todo - store and use it
			incomingMessage.nextUnsignedInteger(this.sendPlayerBitSize);
		}

		//parse frame difference
		var receivedFrameDifference = null;
		if(!this.frameSkipBitSize) {
			//variable length
			receivedFrameDifference = incomingMessage.nextUnsignedInteger()+1;
		}else if(incomingMessage.nextBoolean()) {
			//preset length
			receivedFrameDifference = incomingMessage.nextUnsignedInteger(this.frameSkipBitSize)+1;
		}else {
			//variable length
			receivedFrameDifference = incomingMessage.nextUnsignedInteger()+1;
		}

		//parse command
		var c = this._getNewCommand();
		c.loadFromMessage(incomingMessage);

		//parse should dump
		var shouldDump = incomingMessage.nextBoolean();

		//parse sync value
		if(!shouldDump) {
			this._syncServer(incomingMessage.finalUnsignedInteger());
		}

		//declare variables
		var p = null;

		//set player
		if(this.shouldSendPlayer) {
			//todo - use popped player variable
		}else {
			//only 2 players
			p = this.enemyPlayer;
		}

		//add frame to command
		if(this.shouldSendFrame) {
			//todo - code this
		}

		//store command
		p.commands.add(c);

		//duplicate
		if(!this.shouldSendFrame) {
			//loop
			for(var i=1, duplicate=null; i<receivedFrameDifference; i++) {
				//create command
				duplicate = this._getNewCommand();
				duplicate.loadFromCommand(c);

				//store command
				p.commands.add(duplicate);
			}
		}

		//received frame difference
		if(this.shouldSendPlayer) {
			//todo - add frame difference to it
		}else {
			//increment
			this.receivedFrameDifference += receivedFrameDifference;
		}

		//handle dump
		if(shouldDump) {
			//parse dump difference
			var dumpFrameDifference = this.syncFrameDifference + incomingMessage.nextUnsignedInteger(this.syncFrameRateBitSize);

			console.log("received dump with sync frame difference " + this.syncFrameDifference + " dump frame difference " + dumpFrameDifference + " true frame " + this.trueWorld.frame);


			//decode dump
			this.trueWorld.decode(incomingMessage);

			//player
			var p = null;

			//loop
			for(var i=0; i<dumpFrameDifference; i++) {
				//increment command
				for(var j=0; j<this.playerCount; j++) {
					//set player
					p = this.players[j];

					//command
					if(!p.trueCommand) {
						//set to beginning
						p.trueCommand = p.commands.head;
					}else {
						//increment
						p.trueCommand = p.trueCommand.next;
					}
				}

				//increment other variables
				this._syncCheckAfterTrueWorldUpdate();
			}


			//temp - increment frame
			this.trueWorld.frame += dumpFrameDifference;

			console.log("true world post dump frame " + this.trueWorld.frame);

			//reset requested
			this.dumpRequested = false;
		}
	}
};

rollbackclientengine.controllers.PlayController.prototype._onDisconnect = function() {
	//debug
	this.displayedMessage = false;
	this.message = "Disconnected, refresh to play again";

	//toggle boolean
	this.started = false;
};

//command helper - private

rollbackclientengine.controllers.PlayController.prototype._getNewCommand = function() {
	//create
	var c = rollbackgameengine.pool.acquire(this.CommandObject);
	if(!c) {
		c = new this.CommandObject();
	}else {
		//reset
		c.reset();
	}

	//return
	return c;
};
