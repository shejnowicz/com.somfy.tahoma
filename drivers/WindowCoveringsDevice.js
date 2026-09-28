/* jslint node: true */

'use strict';

// Fork (shejnowicz) fixes 2026-09-26: a tilt command no longer cancels an in-flight
// position command (it waits for it), and the real state is re-read from TaHoma
// after a command ends or is cancelled, so an optimistic capability value cannot
// outlive a command that never physically happened.
// Fork fixes 2026-09-27: a position/tilt/open/close command that TaHoma fails with
// "Actuator did not answer" (the io-homecontrol frame was lost, nothing moved) is
// re-issued up to MAX_COMMAND_RETRIES times after RETRY_DELAY_MS; when it finally
// fails the optimistic capability value is reverted to the value captured before the
// command, so a flow reading the capability sees the discrepancy, and the device
// trigger "windowcoverings_command_failed" fires. A tracked command whose terminal
// execution event never arrives is released after COMMAND_WATCHDOG_MS.
// Fork fix 2026-09-28: a cancelled or superseded command (CMDCANCELLED) is not a
// failure - it is only logged and resynced, without reverting the value the newer
// command is driving to, without a device warning and without the failed trigger.
const POSITION_WAIT_SECONDS = 45;
const RESYNC_DELAY_MS = 1500;
const RETRY_DELAY_MS = 20000;
const MAX_COMMAND_RETRIES = 2;
const COMMAND_WATCHDOG_MS = 120000;

const Device = require('./Device');

/**
 * Retry decision for a failed command. Only TaHoma's "actuator did not answer" is
 * worth retrying: the frame was lost and the motor did nothing. It arrives either as
 * the execution failure type (ACTUATORNOANSWER) or as the API error text mapped by
 * app.js ("Actuator did not answer"). Obstacle / wind protection, cancellation and
 * every other failure are final.
 * @param {string} reason failure type or error message
 * @returns {boolean}
 */
function shouldRetryFailure(reason)
{
	const text = String(reason || '');
	return (text.toLowerCase().indexOf('did not answer') >= 0) || (text.toUpperCase().indexOf('NOANSWER') >= 0);
}

/**
 * A cancellation is not a failure. TaHoma answers CMDCANCELLED when a newer command
 * takes an execution over (a flow sending "close" and then a position does exactly
 * that on every blind), so the motor is fine and the newer command is already on its
 * way. Such an outcome must not revert, warn or notify. It stays non-retryable.
 * @param {string} reason failure type or error message
 * @returns {boolean}
 */
function isCancellation(reason)
{
	const text = String(reason || '').toUpperCase();
	return (text.indexOf('CANCELLED') >= 0) || (text.indexOf('CANCELED') >= 0);
}

/**
 * Base class for window coverings devices
 * @extends {Device}
 */
class WindowCoveringsDevice extends Device
{

	async onInit()
	{
		this.requiresQuietMode = false;

		if (this.hasCapability('lock_state'))
		{
			this.driver.lock_state_changedTrigger = this.homey.flow.getDeviceTriggerCard('lock_state_changed');
		}

		const classType = this.getSetting('classType');
		if (classType === null)
		{
			this.setSettings({ classType: this.getClass() });
		}

		this.invertPosition = this.getSetting('invertPosition');
		if (this.invertPosition === null)
		{
			this.invertPosition = false;
		}

		this.invertTile = this.getSetting('invertTile');
		if (this.invertTile === null)
		{
			this.invertTile = false;
		}

		this.invertUpDown = this.getSetting('invertUpDown');
		if (this.invertUpDown === null)
		{
			this.invertUpDown = false;
		}

		if (this.invertUpDown)
		{
			// Homey capability to Somfy command map
			this.windowcoveringsActions = {
				up: 'close',
				idle: 'stop',
				down: 'open',
			};

			// Somfy state to Homey capability map
			this.windowcoveringsStatesMap = {
				open: 'down',
				closed: 'up',
				unknown: 'idle',
			};
		}
		else
		{
			this.windowcoveringsActions = {
				up: 'open',
				idle: 'stop',
				down: 'close',
			};

			this.windowcoveringsStatesMap = {
				open: 'up',
				closed: 'down',
				unknown: 'idle',
			};
		}

		this.clearStateTimer = null;
		this.positionStateName = 'core:ClosureState'; // Name of state to get the current position
		this.setPositionActionName = 'setClosure'; // Name of the command to set the current position
		this.openClosedStateName = 'core:OpenClosedState'; // Name of the state to get open / closed state
		this.myCommand = 'my'; // Name of the command to set the My position
		this.lastDispatchedCommand = '';
		this.lastDispatchedAt = 0;
		this.lastFailureType = '';
		this.lastPedestrianState = null;

		// Command issued by this driver that is still in flight, retry-pending or
		// awaiting its terminal execution event (see startTrackedCommand).
		this.commandSeq = 0;
		this.pendingCommand = null;
		this.retryTimer = null;
		this.watchdogTimer = null;

		this.quietMode = false;

		this.registerCapabilityListener('windowcoverings_state', this.onCapabilityWindowcoveringsState.bind(this));
		this.registerCapabilityListener('windowcoverings_set', this.onCapabilityWindowcoveringsSet.bind(this));
		this.registerCapabilityListener('windowcoverings_tilt_up', this.onCapabilityWindowcoveringsTiltUp.bind(this));
		this.registerCapabilityListener('windowcoverings_tilt_down', this.onCapabilityWindowcoveringsTiltDown.bind(this));
		this.registerCapabilityListener('my_position', this.onCapabilityMyPosition.bind(this));
		this.registerCapabilityListener('windowcoverings_closed', this.onCapabilityWindowcoveringsClosed.bind(this));
		this.registerCapabilityListener('windowcoverings_tilt_set', this.onCapabilityWindowcoveringsTiltSet.bind(this));

		await super.onInit();

		this.boostSync = true;
	}

	onAdded()
	{
		this.log('device added');
		this.sync();
	}

	async onSettings({ oldSettings, newSettings, changedKeys })
	{
		if (changedKeys.indexOf('invertUpDown') >= 0)
		{
			this.invertUpDown = newSettings.invertUpDown;

			if (this.invertUpDown)
			{
				this.windowcoveringsActions = {
					up: 'close',
					idle: 'stop',
					down: 'open',
				};

				this.windowcoveringsStatesMap = {
					open: 'down',
					closed: 'up',
					unknown: 'idle',
				};
			}
			else
			{
				this.windowcoveringsActions = {
					up: 'open',
					idle: 'stop',
					down: 'close',
				};

				this.windowcoveringsStatesMap = {
					open: 'up',
					closed: 'down',
					unknown: 'idle',
				};
			}
		}

		if (changedKeys.indexOf('invertTile') >= 0)
		{
			this.invertTile = newSettings.invertTile;
		}

		if (changedKeys.indexOf('invertPosition') >= 0)
		{
			this.invertPosition = newSettings.invertPosition;
		}

		if (changedKeys.indexOf('classType') >= 0)
		{
			this.setClass(newSettings.classType);
		}
	}

	shouldThrottleDuplicateCommand(signature, minIntervalMs = 2500)
	{
		const now = Date.now();
		if ((this.lastDispatchedCommand === signature) && ((now - this.lastDispatchedAt) < minIntervalMs))
		{
			return true;
		}

		this.lastDispatchedCommand = signature;
		this.lastDispatchedAt = now;
		return false;
	}

	logCapabilityCommandError(context, err)
	{
		const errorMessage = (err && err.message) ? err.message : String(err);
		if (this.homey && this.homey.app && (typeof this.homey.app.logInformation === 'function'))
		{
			this.homey.app.logInformation(`${this.getName()}: ${context}`, errorMessage);
		}
		else
		{
			this.error(errorMessage);
		}
	}

	async onCapabilityWindowcoveringsState(value, opts)
	{
		if (!opts || !opts.fromCloudSync)
		{
			if (this.windowcoveringsActions[value] === null)
			{
				// Action is not supported
				this.homey.app.logInformation(`${this.getName()}: onCapabilityWindowcoveringsState`, 'option not supported');
				return;
			}

			try
			{
				const deviceData = this.getData();
				const nextCommand = this.windowcoveringsActions[value];

				if (this.shouldThrottleDuplicateCommand(`state:${nextCommand}`))
				{
					this.homey.app.logInformation(`${this.getName()}: onCapabilityWindowcoveringsState`, `Ignoring duplicate command ${nextCommand}`);
					return;
				}

				if (value === 'idle' && (this.executionId !== null))
				{
					await this.homey.app.cancelExecution(deviceData.label, this.executionId.id, this.executionId.local);
					this.executionCmd = '';
					this.executionId = null;
					this.scheduleResync();
				}

				if (this.executionCmd !== null)
				{
					if (this.executionCmd === this.windowcoveringsActions[value])
					{
						// Already executing this command so ignore it
						this.homey.app.logInformation(`${this.getName()}: onCapabilityWindowcoveringsState`, `command ${this.executionCmd} already executing`);
						return;
					}

					if (this.executionId !== null)
					{
						await this.homey.app.cancelExecution(deviceData.label, this.executionId.id, this.executionId.local);
						this.executionCmd = '';
						this.executionId = null;
						this.scheduleResync();
					}
				}
				this.executionCmd = this.windowcoveringsActions[value];

				const action = {
					name: this.executionCmd,
					parameters: [],
				};

				// The tile toggle (windowcoverings_closed) routes through here, so both
				// mirrors of the state are put back on final failure.
				await this.startTrackedCommand('onCapabilityWindowcoveringsState', action, ['windowcoverings_state', 'windowcoverings_closed']);
			}
			catch (err)
			{
				this.executionCmd = '';
				this.setWarning(err.message).catch(this.error);
				this.logCapabilityCommandError('onCapabilityWindowcoveringsState', err);
				// Rejecting keeps Homey from storing the optimistic value for a command
				// the hub never accepted.
				throw err;
			}
			finally
			{
				if (!this.openClosedStateName)
				{
					this.clearStateTimer = this.homey.setTimeout(() =>
					{
						this.clearStateTimer = null;
						this.setCapabilityValue('windowcoverings_state', null).catch(this.error);
					}, 40000);
				}
			}
		}
		else
		{
			// New value from Tahoma
			if (this.homey.app.infoLogEnabled)
			{
				const oldValue = this.getCapabilityValue('windowcoverings_state');
				this.homey.app.logInformation(`${this.getName()}: onCapabilityWindowcoveringsState`, `Old Value: ${oldValue}, New Value: ${value}`);
			}

			this.setCapabilityValue('windowcoverings_state', value).catch(this.error);
			if (this.hasCapability('windowcoverings_closed'))
			{
				if (this.invertTile)
				{
					this.setCapabilityValue('windowcoverings_closed', value !== 'up').catch(this.error);
				}
				else
				{
					this.setCapabilityValue('windowcoverings_closed', value !== 'down').catch(this.error);
				}
			}
		}
	}

	async onCapabilityWindowcoveringsSet(value, opts)
	{
		if (!opts || !opts.fromCloudSync)
		{
			const deviceData = this.getData();

			try
			{
				const throttledValue = Math.round(value * 100) / 100;
				if (this.shouldThrottleDuplicateCommand(`set:${throttledValue}`))
				{
					this.homey.app.logInformation(`${deviceData.label}: onCapabilityWindowcoveringsSet`, `Ignoring duplicate target ${throttledValue}`);
					return;
				}

				if (this.executionCmd !== null)
				{
					if (this.executionCmd === `${this.setPositionActionName}, ${value}`)
					{
						// Already executing this command so ignore it
						this.homey.app.logInformation(`${deviceData.label}: onCapabilityWindowcoveringsSet`, `command ${this.executionCmd} already executing`);
						return;
					}

					if (this.executionId !== null)
					{
						await this.homey.app.cancelExecution(deviceData.label, this.executionId.id, this.executionId.local);
						this.executionCmd = '';
						this.executionId = null;
						this.scheduleResync();
					}
				}
				this.executionCmd = `${this.setPositionActionName}, ${value}`;

				if (this.invertPosition)
				{
					value = 1 - value;
				}
				const action = {
					name: this.setPositionActionName, // Anders pull request
					parameters: [Math.round((1 - value) * 100)],
				};

				if (this.setPositionActionName === 'setPositionAndLinearSpeed')
				{
					// Add low speed option if quiet mode is selected
					action.parameters.push('lowspeed');
				}

				// A subclass may route an up/down state command here (quiet roller
				// shutters); the optimistic value then lives on the state mirrors too.
				const capabilities = ['windowcoverings_set'];
				if (opts && opts.fromState)
				{
					capabilities.push('windowcoverings_state', 'windowcoverings_closed');
				}
				await this.startTrackedCommand('onCapabilityWindowcoveringsSet', action, capabilities);
			}
			catch (err)
			{
				this.executionCmd = '';
				this.setWarning(err.message).catch(this.error);
				this.logCapabilityCommandError('onCapabilityWindowcoveringsSet', err);
				// Rejecting keeps Homey from storing the optimistic value for a command
				// the hub never accepted.
				throw err;
			}
		}
		else
		{
			// New value from Tahoma
			if (this.homey.app.infoLogEnabled)
			{
				const oldValue = this.getCapabilityValue('windowcoverings_set');
				this.homey.app.logInformation(`${this.getName()}: onCapabilityWindowcoveringsSet`, `Old Value ${oldValue}, New Value: ${value}`);
			}

			this.setCapabilityValue('windowcoverings_set', value).catch(this.error);
		}
	}

	async onCapabilityWindowcoveringsTiltSet(value, opts)
	{
		if (!opts || !opts.fromCloudSync)
		{
			const deviceData = this.getData();
			try
			{
				if (this.isCommandBusy())
				{
					let keepRunning = false;
					if (String(this.executionCmd).startsWith(this.setPositionActionName))
					{
						// A position command is still in flight: let it finish. Cancelling it
						// sends Stop and strands the blind at its current position. The wait
						// covers the retry budget so a retried position move is not cut short.
						try
						{
							await this.waitForActionToFinish(POSITION_WAIT_SECONDS + ((MAX_COMMAND_RETRIES * RETRY_DELAY_MS) / 1000));
						}
						catch (waitErr)
						{
							this.homey.app.logInformation(`${deviceData.label}: onCapabilityWindowcoveringsTiltSet`, `waiting for position command: ${waitErr.message}`);
						}

						// Still our own position command after the wait (running late or
						// mid-retry): never stop it. The tilt is sent after it and only takes
						// over the bookkeeping (a pending retry is dropped as superseded).
						keepRunning = (this.pendingCommand !== null);
						if (keepRunning)
						{
							this.homey.app.logInformation(`${deviceData.label}: onCapabilityWindowcoveringsTiltSet`, 'position command still in progress, sending tilt without cancelling it');
						}
					}
					if ((this.executionId !== null) && !keepRunning)
					{
						await this.homey.app.cancelExecution(deviceData.label, this.executionId.id, this.executionId.local);
						this.executionCmd = '';
						this.executionId = null;
						this.scheduleResync();
					}
				}

				const action = {
					name: 'setOrientation',
					parameters: [Math.round((1 - value) * 100)],
				};

				this.executionCmd = action.name;
				await this.startTrackedCommand('onCapabilityWindowcoveringsTiltSet', action, 'windowcoverings_tilt_set');
			}
			catch (err)
			{
				this.executionCmd = '';
				this.setWarning(err.message).catch(this.error);
				this.logCapabilityCommandError('onCapabilityWindowcoveringsTiltSet', err);
				// Rejecting keeps Homey from storing the optimistic value for a command
				// the hub never accepted.
				throw err;
			}
		}
		else if (this.hasCapability('windowcoverings_tilt_set'))
		{
			this.setCapabilityValue('windowcoverings_tilt_set', value).catch(this.error);

			// trigger flows
			const tokens = {
				windowcoverings_tilt: value,
			};
			this.driver.triggerTiltChange(this, tokens);
		}
	}

	async onCapabilityWindowcoveringsTiltUp(value, opts)
	{
		if (!opts || !opts.fromCloudSync)
		{
			const deviceData = this.getData();
			try
			{
				this.abandonTrackedCommand();
				if (this.executionId !== null)
				{
					await this.homey.app.cancelExecution(deviceData.label, this.executionId.id, this.executionId.local);
					this.executionCmd = '';
					this.executionId = null;
					this.scheduleResync();
				}

				const action = {
					name: 'tiltPositive',
					parameters: [3, 1],
				};
				const result = await this.homey.app.executeDeviceAction(deviceData.label, deviceData.deviceURL, action, this.boostSync);
				this.executionCmd = action.name;
				this.executionId = { id: result.execId, local: result.local };

				this.setWarning(null).catch(this.error);
			}
			catch (err)
			{
				this.executionCmd = '';
				this.setWarning(err.message).catch(this.error);
				this.logCapabilityCommandError('onCapabilityWindowcoveringsTiltUp', err);
			}
		}
	}

	async onCapabilityWindowcoveringsTiltDown(value, opts)
	{
		if (!opts || !opts.fromCloudSync)
		{
			const deviceData = this.getData();
			try
			{
				this.abandonTrackedCommand();
				if (this.executionId !== null)
				{
					await this.homey.app.cancelExecution(deviceData.label, this.executionId.id, this.executionId.local);
					this.executionCmd = '';
					this.executionId = null;
					this.scheduleResync();
				}

				const action = {
					name: 'tiltNegative',
					parameters: [3, 1],
				};
				const result = await this.homey.app.executeDeviceAction(deviceData.label, deviceData.deviceURL, action, this.boostSync);
				this.executionCmd = action.name;
				this.executionId = { id: result.execId, local: result.local };

				this.setWarning(null).catch(this.error);
			}
			catch (err)
			{
				this.executionCmd = '';
				this.setWarning(err.message).catch(this.error);
				this.logCapabilityCommandError('onCapabilityWindowcoveringsTiltDown', err);
			}
		}
	}

	async onCapabilityMyPosition(value, opts)
	{
		if (!opts || !opts.fromCloudSync)
		{
			const deviceData = this.getData();
			try
			{
				this.abandonTrackedCommand();
				if (this.executionId !== null)
				{
					await this.homey.app.cancelExecution(deviceData.label, this.executionId.id, this.executionId.local);
				}

				const action = {
					name: this.myCommand,
					parameters: [],
				};
				const result = await this.homey.app.executeDeviceAction(deviceData.label, deviceData.deviceURL, action, this.boostSync);
				this.executionCmd = action.name;
				this.executionId = { id: result.execId, local: result.local };

				this.setWarning(null).catch(this.error);
			}
			catch (err)
			{
				this.executionCmd = '';
				this.setWarning(err.message).catch(this.error);
				this.logCapabilityCommandError('onCapabilityMyPosition', err);
			}
		}
	}

	async onCapabilityPedestrian(value, opts)
	{
		if (!opts || !opts.fromCloudSync)
		{
			const deviceData = this.getData();
			try
			{
				this.abandonTrackedCommand();
				if (this.executionId !== null)
				{
					await this.homey.app.cancelExecution(deviceData.label, this.executionId.id, this.executionId.local);
				}

				const action = {
					name: 'setPedestrianPosition',
					parameters: [],
				};
				const result = await this.homey.app.executeDeviceAction(deviceData.label, deviceData.deviceURL, action, this.boostSync);
				this.executionCmd = action.name;
				this.executionId = { id: result.execId, local: result.local };

				this.setWarning(null).catch(this.error);
			}
			catch (err)
			{
				this.executionCmd = '';
				this.setWarning(err.message).catch(this.error);
				this.logCapabilityCommandError('onCapabilityPedestrian', err);
			}

			this.setWarning(null).catch(this.error);
		}
		else
		{
			// New value from Tahoma
			// trigger flows
			const tokens = {
				pedestrian: value,
			};
			this.driver.triggerPedestrianChange(this, tokens);
		}
	}

	updatePedestrianState(value)
	{
		const pedestrianState = (value === 'pedestrian');
		if (this.lastPedestrianState === pedestrianState)
		{
			return;
		}

		this.lastPedestrianState = pedestrianState;
		this.triggerCapabilityListener('pedestrian', pedestrianState,
		{
			fromCloudSync: true,
		}).catch(this.error);
	}

	async onCapabilityWindowcoveringsClosed(value, opts)
	{
		if (this.invertTile)
		{
			return this.onCapabilityWindowcoveringsState(value ? 'down' : 'up', null);
		}

			return this.onCapabilityWindowcoveringsState(value ? 'up' : 'down', null);
	}

	/**
	 * Sync the state of the devices from the TaHoma cloud with Homey
	 */
	async sync()
	{
		try
		{
			let foundActiveOptionstate = false;

			let states = await super.getStates();
			if (states)
			{
				if (this.hasCapability('lock_state'))
				{
					const lockState = states.find((state) => (state && (state.name === 'io:PriorityLockOriginatorState')));
					if (lockState)
					{
						this.homey.app.logStates(`${this.getName()}: io:PriorityLockOriginatorState = ${lockState.value}`);
						this.setCapabilityValue('lock_state', lockState.value).catch(this.error);
						if (this.driver.triggerLockStateChange)
						{
							const tokens = {
								lock_state: lockState.value,
							};
							this.driver.triggerLockStateChange(this, tokens);
						}

						if (this.checkLockSate)
						{
							clearTimeout(this.checkLockStateTimer);
							this.checkLockStateTimer = this.homey.setTimeout(this.checkLockSate, 60 * 30000);
						}
					}
					else
					{
						const lockStateTimer = states.find((state) => (state && (state.name === 'core:PriorityLockTimerState')));
						if (lockStateTimer)
						{
							this.homey.app.logStates(`${this.getName()}: core:PriorityLockTimerState = ${lockStateTimer.value}`);
							if ((lockStateTimer.value === '0') || (lockStateTimer.value === 0))
							{
								this.setCapabilityValue('lock_state', '').catch(this.error);
								if (this.driver.triggerLockStateChange)
								{
									const tokens = {
										lock_state: '',
									};
									this.driver.triggerLockStateChange(this, tokens);
								}
							}
							else if (this.checkLockSate)
							{
								clearTimeout(this.checkLockStateTimer);
								this.checkLockStateTimer = this.homey.setTimeout(this.checkLockSate, (60 * parseInt(lockStateTimer.value, 10)));
							}
						}
					}
				}

				const myPosition = states.find((state) => (state && (state.name === 'core:Memorized1PositionState')));
				if (myPosition)
				{
					if (!this.hasCapability('my_value'))
					{
						await this.addCapability('my_value');
					}

					this.homey.app.logStates(`${this.getName()}: core:Memorized1PositionState = ${myPosition.value}`);
					this.setCapabilityValue('my_value', myPosition.value).catch(this.error);
				}

				// device exists -> let's sync the state of the device
				const closureState = states.find((state) => (state && (state.name === this.positionStateName)));
				const openClosedState = states.find((state) => (state && (state.name === this.openClosedStateName)));
				const tiltState = states.find((state) => (state && (state.name === 'core:SlateOrientationState')));

				if (this.unavailable)
				{
					this.unavailable = false;
					this.setAvailable().catch(this.error);
				}

				if (openClosedState)
				{
					this.homey.app.logStates(`${this.getName()}: ${this.openClosedStateName} = ${openClosedState.value}`);
					if (this.hasCapability('pedestrian'))
					{
						this.updatePedestrianState(openClosedState.value);
					}

					// Convert Tahoma states to Homey equivalent
					if (closureState && (closureState.value !== 0) && (closureState.value !== 100))
					{
						// Not fully open or closed
						openClosedState.value = 'idle';
					}
					else
					{
						openClosedState.value = this.windowcoveringsStatesMap[openClosedState.value];
					}

					this.triggerCapabilityListener('windowcoverings_state', openClosedState.value,
					{
						fromCloudSync: true,
					}).catch(this.error);
				}

				if (closureState)
				{
					this.homey.app.logStates(`${this.getName()}: ${this.positionStateName} = ${closureState.value}`);

					if (this.invertPosition)
					{
						closureState.value = 100 - closureState.value;
					}
					this.triggerCapabilityListener('windowcoverings_set', 1 - (closureState.value / 100),
					{
						fromCloudSync: true,
					}).catch(this.error);
				}

				if (tiltState)
				{
					this.homey.app.logStates(`${this.getName()}: core:SlateOrientationState = ${tiltState.value}`);

					this.triggerCapabilityListener('windowcoverings_tilt_set', 1 - (tiltState.value / 100),
					{
						fromCloudSync: true,
					}).catch(this.error);
				}

				const batteryLevelState = states.find((state) => (state && (state.name === 'core:BatteryLevelState')));
				if (batteryLevelState)
				{
					// Device battery level state
					this.hasBatteryLevelState = true;
					await this.updateBatteryLevelCapability(batteryLevelState);
				}
				else
				{
					const batteryState = states.find((state) => (state && (state.name === 'core:BatteryState')));
					if (batteryState)
					{
						await this.updateBatteryLevelCapability(batteryState);
					}
					else
					{
						const relatedBatteryState = await this.getRelatedDeviceState(
							['core:BatteryLevelState', 'core:BatteryState'],
							this.getDeviceUrl(),
						);
						if (relatedBatteryState && (relatedBatteryState.name === 'core:BatteryLevelState'))
						{
							this.hasBatteryLevelState = true;
						}
						await this.updateBatteryLevelCapability(relatedBatteryState);
					}
				}

				const silentState = states.find((state) => (state && (state.name === 'core:ActivatedOptionsState')));
				if (silentState)
				{
					this.homey.app.logStates(`${this.getName()}: core:ActivatedOptionsState = ${silentState.value}`);
					if (!this.hasCapability('quiet_mode'))
					{
						await this.addCapability('quiet_mode');
					}
					this.setCapabilityValue('quiet_mode', silentState.value.includes('silence')).catch(this.error);
					foundActiveOptionstate = true;
				}

				states = null;
			}
			else if (this.openClosedStateName === '')
			{
				// RTS devices have no feedback
				if (this.unavailable)
				{
					this.unavailable = false;
					this.setAvailable().catch(this.error);
				}

				this.log(this.getName(), ' No device status');

				this.setCapabilityValue('windowcoverings_state', null).catch(this.error);
			}

			if (!this.requiresQuietMode && !foundActiveOptionstate && this.hasCapability('quiet_mode'))
			{
				this.removeCapability('quiet_mode').catch(this.error);
			}
		}
		catch (error)
		{
			this.homey.app.logInformation(this.getName(),
			{
				message: error.message,
				stack: error.stack,
			});
		}
	}

	/**
	 * Sync the state of the devices from the TaHoma cloud with Homey
	 */
	async syncEvents(events, local)
	{
		if (events === null)
		{
			this.sync();
			return;
		}

		try
		{
			const myURL = this.getDeviceUrl();

			let lastPosition = null;

			// Process events sequentially so they are in the correct order
			for (let i = 0; i < events.length; i++)
			{
				const element = events[i];
				if (element.name === 'DeviceStateChangedEvent')
				{
					if (this.isRelatedDeviceURL(element.deviceURL, myURL) && Array.isArray(element.deviceStates))
					{
						if (this.homey.app.infoLogEnabled)
						{
							this.homey.app.logInformation(this.getName(),
							{
								message: 'Processing device state change event',
								stack: element,
							});
						}

						// Got what we need to update the device so lets find it
						if (this.unavailable)
						{
							this.unavailable = false;
							this.setAvailable().catch(this.error);
						}

						for (let x = 0; x < element.deviceStates.length; x++)
						{
							const deviceState = element.deviceStates[x];

							// Device lock state
							if (deviceState.name === 'io:PriorityLockOriginatorState')
							{
								if (this.hasCapability('lock_state') && (deviceState.value))
								{
									this.homey.app.logStates(`${this.getName()}: io:PriorityLockOriginatorState = ${deviceState.value}`);
									this.setCapabilityValue('lock_state', deviceState.value).catch(this.error);
									if (this.driver.triggerLockStateChange)
									{
										const tokens = {
											lock_state: deviceState.value,
										};
										this.driver.triggerLockStateChange(this, tokens);
									}
									if (this.checkLockSate)
									{
										// Setup timer to call a function to check if it can be cleared
										clearTimeout(this.checkLockStateTimer);
										this.checkLockStateTimer = this.homey.setTimeout(this.checkLockSate, (60 * 30000));
									}
								}
							}
							else if (deviceState.name === 'core:PriorityLockTimerState')
							{
								if (this.hasCapability('lock_state') && (deviceState.value))
								{
									this.homey.app.logStates(`${this.getName()}: core:PriorityLockTimerState = ${deviceState.value}`);
									if ((deviceState.value === '0') || (deviceState.value === 0))
									{
										this.setCapabilityValue('lock_state', '').catch(this.error);
										if (this.driver.triggerLockStateChange)
										{
											const tokens = {
												lock_state: '',
											};
											this.driver.triggerLockStateChange(this, tokens);
										}
									}
									else if (this.checkLockSate)
									{
										clearTimeout(this.checkLockStateTimer);
										this.checkLockStateTimer = this.homey.setTimeout(this.checkLockSate, (60 * parseInt(deviceState.value, 10)));
									}
								}
							}
							else if (deviceState.name === this.positionStateName)
							{
								// Check for more message that are the same
								if (!this.checkForDuplicatesEvents(events, i, x + 1, myURL, this.positionStateName))
								{
									// Device position
									let closureStateValue = parseInt(deviceState.value, 10);
									this.homey.app.logStates(`${this.getName()}: ${this.positionStateName} = ${closureStateValue}`);

									if (this.invertPosition)
									{
										closureStateValue = 100 - closureStateValue;
									}

									this.triggerCapabilityListener('windowcoverings_set', 1 - (closureStateValue / 100),
									{
										fromCloudSync: true,
									}).catch(this.error);

									if ((closureStateValue !== 0) && (closureStateValue !== 100))
									{
										// Not fully open or closed
										this.triggerCapabilityListener('windowcoverings_state', 'idle',
										{
											fromCloudSync: true,
										}).catch(this.error);

										lastPosition = closureStateValue;
									}
									else
									{
										lastPosition = null;
									}
								}
							}
							else if (deviceState.name === this.openClosedStateName)
							{
								// Check for more message that are the same
								if (!this.checkForDuplicatesEvents(events, i, x + 1, myURL, this.openClosedStateName))
								{
									if (this.hasCapability('pedestrian'))
									{
										this.updatePedestrianState(deviceState.value);
									}

									// Device Open / Closed state. Only process if the last position was 0 or 100
									if (lastPosition === null)
									{
										let openClosedStateValue = deviceState.value;
										this.homey.app.logStates(`${this.getName()}: ${this.openClosedStateName} = ${openClosedStateValue}`);

										// Convert Tahoma states to Homey equivalent
										openClosedStateValue = this.windowcoveringsStatesMap[openClosedStateValue];

										this.triggerCapabilityListener('windowcoverings_state', openClosedStateValue,
										{
											fromCloudSync: true,
										}).catch(this.error);
									}

									lastPosition = null;
								}
							}
							else if (deviceState.name === 'core:SlateOrientationState')
							{
								// Device tilt position
								// Check for more message that are the same
								if (!this.checkForDuplicatesEvents(events, i, x + 1, myURL, 'core:SlateOrientationState'))
								{
									const tiltStateValue = parseInt(deviceState.value, 10);
									this.homey.app.logStates(`${this.getName()}: core:SlateOrientationState = ${tiltStateValue}`);

									this.triggerCapabilityListener('windowcoverings_tilt_set', 1 - (tiltStateValue / 100),
									{
										fromCloudSync: true,
									}).catch(this.error);
								}
							}
							else if (deviceState.name === 'core:BatteryLevelState')
							{
								// Device battery level state
								this.hasBatteryLevelState = true;

								// Check for more message that are the same
								if (!this.checkForDuplicatesEvents(events, i, x + 1, myURL, 'core:BatteryLevelState'))
								{
									await this.updateBatteryLevelCapability(deviceState);
								}
							}
							else if ((deviceState.name === 'core:BatteryState') && !this.hasBatteryLevelState)
							{
								// Device battery state
								// Check for more message that are the same
								if (!this.checkForDuplicatesEvents(events, i, x + 1, myURL, 'core:BatteryState'))
								{
									await this.updateBatteryLevelCapability(deviceState);
								}
							}
							else if (deviceState.name === 'core:ActivatedOptionsState')
							{
								// Check for more message that are the same
								if (!this.checkForDuplicatesEvents(events, i, x + 1, myURL, 'core:ActivatedOptionsState'))
								{
									const silentStateValue = deviceState.value;
									this.homey.app.logStates(`${this.getName()}: core:ActivatedOptionsState = ${silentStateValue}`);
									if (!this.hasCapability('quiet_mode'))
									{
										await this.addCapability('quiet_mode');
									}
									this.triggerCapabilityListener('quiet_mode', silentStateValue.includes('silence'),
									{
										fromCloudSync: true,
									}).catch(this.error);
								}
							}
						}
					}
				}
				else if (element.name === 'ExecutionRegisteredEvent')
				{
					if (!Array.isArray(element.actions))
					{
						continue;
					}
					for (let x = 0; x < element.actions.length; x++)
					{
						if (myURL === element.actions[x].deviceURL)
						{
							if (!this.executionId || (this.executionId.id !== element.execId))
							{
								this.executionId = { id: element.execId, local };
								if (element.actions[x].commands)
								{
									this.executionCmd = element.actions[x].commands[0].name;
								}
								else
								{
									this.executionCmd = element.actions[x].command;
								}

								this.lastCommandFailed = false;
								this.lastFailureType = '';

								if (!local && this.boostSync)
								{
									if (!await this.homey.app.boostSync())
									{
										this.executionId = null;
										this.executionCmd = '';
									}
								}
							}
						}
					}
				}
				else if (element.name === 'ExecutionStateChangedEvent')
				{
					if ((element.newState === 'COMPLETED') || (element.newState === 'FAILED') || (element.newState === 'CANCELLED'))
					{
						if (this.executionId && (this.executionId.id === element.execId))
						{
							if (!local && this.boostSync)
							{
								await this.homey.app.unBoostSync();
							}

							if (this.clearStateTimer && ((this.executionCmd === 'up') || (this.executionCmd === 'down') || (this.executionCmd === 'idle') || (this.executionCmd === 'close') || (this.executionCmd === 'open')) && !this.openClosedStateName)
							{
								clearTimeout(this.clearStateTimer);
								this.clearStateTimer = null;
								this.setCapabilityValue('windowcoverings_state', null).catch(this.error);
							}

							const failed = (element.newState === 'FAILED');
							const failureType = failed ? this.getExecutionFailureType(element) : '';
							const command = this.pendingCommand;
							const isTrackedCommand = (command !== null) && (command.execId === element.execId);
							this.executionId = null;

							if (isTrackedCommand && failed && this.canRetryCommand(command, failureType))
							{
								// The actuator did not answer, so nothing moved: re-issue the same
								// command. executionCmd and pendingCommand stay set, which keeps the
								// device busy for the wait card and the tilt handler meanwhile.
								this.scheduleCommandRetry(command, failureType);
								continue;
							}

							this.homey.app.triggerCommandComplete(this, this.executionCmd, (element.newState === 'COMPLETED'));
							this.driver.triggerDeviceCommandComplete(this, this.executionCmd, (element.newState === 'COMPLETED'));
							this.executionCmd = '';
							this.lastCommandFailed = failed;
							this.lastFailureType = failureType;

							// A cancelled or failed command produces no DeviceStateChangedEvent, so the
							// optimistic capability value must be corrected from the real state.
							this.scheduleResync();

							if (isTrackedCommand)
							{
								this.clearCommandWatchdog();
								this.pendingCommand = null;
								if (failed)
								{
									this.reportCommandFailure(command, failureType);
								}
							}
							else if ((command !== null) && (command.execId !== null))
							{
								// The execution we were following was someone else's and our own
								// terminal event never matched (missed or superseded): stop waiting
								// for it; the resync above fetches the real state.
								this.abandonTrackedCommand();
							}

							if (this.lastFailureType.toUpperCase() === 'ACTUATORNOANSWER')
							{
								this.setWarning('Actuator did not answer').catch(this.error);
							}
						}
					}
				}
			}
		}
		catch (error)
		{
			this.homey.app.logInformation(this.getName(),
			{
				message: error.message,
				stack: error.stack,
			});
		}
	}

	scheduleResync()
	{
		if (this.resyncTimer)
		{
			this.homey.clearTimeout(this.resyncTimer);
		}
		this.resyncTimer = this.homey.setTimeout(() =>
		{
			this.resyncTimer = null;
			this.sync().catch(this.error);
		}, RESYNC_DELAY_MS);
	}

	async waitForActionToFinish(timeout)
	{
		let retries = timeout;
		while (this.isCommandBusy() && (retries-- > 0))
		{
			await this.homey.app.asyncDelay(1000);
		}

		if (this.lastCommandFailed)
		{
			if (this.lastFailureType && shouldRetryFailure(this.lastFailureType))
			{
				throw new Error('Actuator did not answer');
			}

			throw new Error('Command failed');
		}

		if (retries <= 0)
		{
			throw new Error('Timeout waiting for action to finish');
		}
	}

	/**
	 * True while a command issued by this driver has not reached a terminal outcome:
	 * request in flight, execution running (executionId known) or a retry pending.
	 * Executions started elsewhere (TaHoma app, scenarios) count through executionId.
	 */
	isCommandBusy()
	{
		return (this.executionId !== null) || (this.pendingCommand !== null);
	}

	/**
	 * Issue a command this driver owns (position, tilt, open/close/stop) and track it
	 * so a "did not answer" failure can be retried and a final failure reported
	 * honestly. Resolves once the hub accepted the command or a retry is pending;
	 * rejects only when the command is finally lost. The capability values are
	 * captured here, before Homey stores the optimistic target, so they can be put
	 * back on final failure.
	 * @param {string} context handler name, used in the log
	 * @param {{name: string, parameters: Array}} action TaHoma command
	 * @param {string|string[]} capabilities capabilities whose optimistic value the command backs
	 */
	async startTrackedCommand(context, action, capabilities)
	{
		this.abandonTrackedCommand();
		this.commandSeq += 1;
		this.lastCommandFailed = false;
		this.lastFailureType = '';

		const command = {
			seq: this.commandSeq,
			context,
			action,
			executionCmd: this.executionCmd,
			reverts: [],
			attempts: 0,
			execId: null,
		};
		const names = Array.isArray(capabilities) ? capabilities : [capabilities];
		for (const capability of names)
		{
			if (capability && this.hasCapability(capability))
			{
				command.reverts.push({ capability, previousValue: this.getCapabilityValue(capability) });
			}
		}

		this.pendingCommand = command;
		await this.launchCommand(command);
	}

	async launchCommand(command)
	{
		const deviceData = this.getData();
		command.attempts += 1;
		this.executionCmd = command.executionCmd;

		let result;
		try
		{
			result = await this.homey.app.executeDeviceAction(deviceData.label, deviceData.deviceURL, command.action, this.boostSync);
		}
		catch (err)
		{
			if (this.pendingCommand !== command)
			{
				// Superseded by a newer command while the request was in flight.
				return;
			}

			const reason = (err && err.message) ? err.message : String(err);
			if (this.canRetryCommand(command, reason))
			{
				this.scheduleCommandRetry(command, reason);
				return;
			}

			this.executionCmd = '';
			this.lastFailureType = reason;
			this.pendingCommand = null;

			if (isCancellation(reason))
			{
				// A newer command took this one over: rejecting here would make the caller
				// set a device warning and Homey drop the value the newer command drives to.
				this.reportCommandCancelled(command, reason);
				return;
			}

			this.lastCommandFailed = true;
			this.reportCommandFailure(command, reason);
			throw err;
		}

		if (this.pendingCommand !== command)
		{
			// Superseded by a newer command while the request was in flight: the newer
			// command owns the bookkeeping, so stop this execution rather than let two
			// moves compete on the device.
			this.homey.app.logInformation(`${deviceData.label}: ${command.context}`, `execution ${result.execId} superseded by a newer command, cancelling it`);
			await this.homey.app.cancelExecution(deviceData.label, result.execId, result.local);
			return;
		}

		command.execId = result.execId;
		this.executionId = { id: result.execId, local: result.local };
		this.armCommandWatchdog(command);

		this.setWarning(null).catch(this.error);
	}

	canRetryCommand(command, reason)
	{
		// A lost Stop is not re-sent 20 s later: by then it would stop whatever the
		// blind is doing for someone else.
		return (command.action.name !== 'stop') && (command.attempts <= MAX_COMMAND_RETRIES) && shouldRetryFailure(reason);
	}

	scheduleCommandRetry(command, reason)
	{
		const deviceData = this.getData();
		this.cancelPendingRetry();
		this.clearCommandWatchdog();
		this.homey.app.logInformation(`${deviceData.label}: ${command.context}`, `retry ${command.attempts}/${MAX_COMMAND_RETRIES} in ${RETRY_DELAY_MS / 1000} s after: ${this.describeFailure(reason)}`);
		this.retryTimer = this.homey.setTimeout(() =>
		{
			this.retryTimer = null;
			if (this.pendingCommand !== command)
			{
				// A newer command for this device replaced it meanwhile.
				return;
			}

			this.launchCommand(command).catch((err) =>
			{
				this.logCapabilityCommandError(command.context, err);
			});
		}, RETRY_DELAY_MS);
	}

	cancelPendingRetry()
	{
		if (this.retryTimer)
		{
			this.homey.clearTimeout(this.retryTimer);
			this.retryTimer = null;
		}
	}

	/**
	 * Drop the tracked command without reporting it: a command outside the tracked
	 * set (nudge, My, pedestrian, quiet mode) or a newer tracked command takes over
	 * the device, so a pending retry must not fire over it and the old outcome is no
	 * longer ours to report.
	 */
	abandonTrackedCommand()
	{
		this.cancelPendingRetry();
		this.clearCommandWatchdog();
		this.pendingCommand = null;
	}

	/**
	 * Release a tracked command whose terminal execution event never arrives (missed
	 * poll, hub restart), so the device does not stay busy until the next command.
	 */
	armCommandWatchdog(command)
	{
		this.clearCommandWatchdog();
		this.watchdogTimer = this.homey.setTimeout(() =>
		{
			this.watchdogTimer = null;
			if ((this.pendingCommand !== command) || (this.executionId === null) || (this.executionId.id !== command.execId))
			{
				return;
			}

			const deviceData = this.getData();
			this.homey.app.logInformation(`${deviceData.label}: ${command.context}`, `no terminal event within ${COMMAND_WATCHDOG_MS / 1000} s for execution ${command.execId}, releasing it`);
			this.executionId = null;
			this.executionCmd = '';
			this.pendingCommand = null;
			this.scheduleResync();
		}, COMMAND_WATCHDOG_MS);
	}

	clearCommandWatchdog()
	{
		if (this.watchdogTimer)
		{
			this.homey.clearTimeout(this.watchdogTimer);
			this.watchdogTimer = null;
		}
	}

	getExecutionFailureType(element)
	{
		if (element.failureType)
		{
			return String(element.failureType);
		}

		if (Array.isArray(element.failedCommands) && element.failedCommands[0] && element.failedCommands[0].failureType)
		{
			return String(element.failedCommands[0].failureType);
		}

		return '';
	}

	describeFailure(reason)
	{
		if (shouldRetryFailure(reason))
		{
			return 'Actuator did not answer';
		}

		return reason ? String(reason) : 'Command failed';
	}

	/**
	 * Final failure of a tracked command: put the capability back to the value it had
	 * before the command (Homey stored the target optimistically when the listener
	 * resolved), let the real state override it if TaHoma reports one, and fire the
	 * "Command failed" device trigger.
	 */
	reportCommandFailure(command, reason)
	{
		if (isCancellation(reason))
		{
			this.reportCommandCancelled(command, reason);
			return;
		}

		const deviceData = this.getData();
		const description = this.describeFailure(reason);
		this.homey.app.logInformation(`${deviceData.label}: ${command.context}`, `failed after ${command.attempts} attempt(s): ${description}`);

		for (const revert of command.reverts)
		{
			this.setCapabilityValue(revert.capability, revert.previousValue).catch(this.error);
		}
		this.scheduleResync();

		const tokens = {
			command: command.action.name,
			reason: description,
			attempts: command.attempts,
		};
		try
		{
			this.driver.triggerDeviceCommandFailed(this, tokens);
		}
		catch (err)
		{
			this.logCapabilityCommandError('windowcoverings_command_failed', err);
		}
	}

	/**
	 * Terminal outcome of a tracked command that was cancelled or superseded by a
	 * newer command. Nothing failed, so the captured values are NOT put back (they
	 * belong to a command that is already running), no device warning is set and the
	 * "Command failed" trigger stays silent; only the real state is re-read.
	 */
	reportCommandCancelled(command, reason)
	{
		const deviceData = this.getData();
		const description = reason ? String(reason) : 'CMDCANCELLED';
		this.homey.app.logInformation(`${deviceData.label}: ${command.context}`, `cancelled after ${command.attempts} attempt(s): ${description} - superseded by a newer command, not a failure`);
		this.lastCommandFailed = false;
		this.scheduleResync();
	}

	onDeleted()
	{
		this.abandonTrackedCommand();
		if (this.resyncTimer)
		{
			this.homey.clearTimeout(this.resyncTimer);
			this.resyncTimer = null;
		}
		return super.onDeleted();
	}

}

WindowCoveringsDevice.shouldRetryFailure = shouldRetryFailure;
WindowCoveringsDevice.isCancellation = isCancellation;

module.exports = WindowCoveringsDevice;
