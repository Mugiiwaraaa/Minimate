// Minimate Controller & Module Library v0.1
// Kieback & Peter DDC controller formats

var CONTROLLERS = {
  'ME521': {
    name: 'ME521',
    brand: 'KIEBACK & PETER',
    outputs: [
      { pin: 'UO1', label: 'UNIVERSAL OUTPUT 1', type: 'UO' },
      { pin: 'UO2', label: 'UNIVERSAL OUTPUT 2', type: 'UO' },
      { pin: 'UO3', label: 'UNIVERSAL OUTPUT 3', type: 'UO' },
      { pin: 'UO4', label: 'UNIVERSAL OUTPUT 4', type: 'UO' },
      { pin: 'UO5', label: 'UNIVERSAL OUTPUT 5', type: 'UO' },
      { pin: 'UO6', label: 'UNIVERSAL OUTPUT 6', type: 'UO' },
      { pin: 'UO7', label: 'UNIVERSAL OUTPUT 7', type: 'UO' },
      { pin: 'UO8', label: 'UNIVERSAL OUTPUT 8', type: 'UO' }
    ],
    inputs: [
      { pin: 'UI3', label: 'UNIVERSAL INPUT 3', type: 'UI' },
      { pin: 'UI4', label: 'UNIVERSAL INPUT 4', type: 'UI' },
      { pin: 'UI5', label: 'UNIVERSAL INPUT 5', type: 'UI' },
      { pin: 'UI6', label: 'UNIVERSAL INPUT 6', type: 'UI' },
      { pin: 'UI7', label: 'UNIVERSAL INPUT 7', type: 'UI' },
      { pin: 'UI8', label: 'UNIVERSAL INPUT 8', type: 'UI' },
      { pin: 'UI9', label: 'UNIVERSAL INPUT 9', type: 'UI' },
      { pin: 'UI10', label: 'UNIVERSAL INPUT 10', type: 'UI' }
    ],
    inputStart: 3,
    maxModules: 4,
    description: 'ME521 DDC CONTROLLER - 8 UNIVERSAL OUTPUTS + 8 UNIVERSAL INPUTS (UI3-UI10)'
  }
}

var MODULES = {
  'FB8I8O': {
    name: 'FB8I8O',
    brand: 'KIEBACK & PETER',
    outputs: [
      { pin: 'DO1', label: 'DIGITAL OUTPUT 1', type: 'DO' },
      { pin: 'DO2', label: 'DIGITAL OUTPUT 2', type: 'DO' },
      { pin: 'DO3', label: 'DIGITAL OUTPUT 3', type: 'DO' },
      { pin: 'DO4', label: 'DIGITAL OUTPUT 4', type: 'DO' },
      { pin: 'DO5', label: 'DIGITAL OUTPUT 5', type: 'DO' },
      { pin: 'DO6', label: 'DIGITAL OUTPUT 6', type: 'DO' },
      { pin: 'DO7', label: 'DIGITAL OUTPUT 7', type: 'DO' },
      { pin: 'DO8', label: 'DIGITAL OUTPUT 8', type: 'DO' }
    ],
    inputs: [
      { pin: 'DI1', label: 'DIGITAL INPUT 1', type: 'DI' },
      { pin: 'DI2', label: 'DIGITAL INPUT 2', type: 'DI' },
      { pin: 'DI3', label: 'DIGITAL INPUT 3', type: 'DI' },
      { pin: 'DI4', label: 'DIGITAL INPUT 4', type: 'DI' },
      { pin: 'DI5', label: 'DIGITAL INPUT 5', type: 'DI' },
      { pin: 'DI6', label: 'DIGITAL INPUT 6', type: 'DI' },
      { pin: 'DI7', label: 'DIGITAL INPUT 7', type: 'DI' },
      { pin: 'DI8', label: 'DIGITAL INPUT 8', type: 'DI' }
    ],
    description: 'FB8I8O EXPANSION MODULE - 8 DIGITAL OUTPUTS + 8 DIGITAL INPUTS'
  },
  'FB16UI': {
    name: 'FB16UI',
    brand: 'KIEBACK & PETER',
    outputs: [],
    inputs: [
      { pin: 'UI1', label: 'UNIVERSAL INPUT 1', type: 'UI' },
      { pin: 'UI2', label: 'UNIVERSAL INPUT 2', type: 'UI' },
      { pin: 'UI3', label: 'UNIVERSAL INPUT 3', type: 'UI' },
      { pin: 'UI4', label: 'UNIVERSAL INPUT 4', type: 'UI' },
      { pin: 'UI5', label: 'UNIVERSAL INPUT 5', type: 'UI' },
      { pin: 'UI6', label: 'UNIVERSAL INPUT 6', type: 'UI' },
      { pin: 'UI7', label: 'UNIVERSAL INPUT 7', type: 'UI' },
      { pin: 'UI8', label: 'UNIVERSAL INPUT 8', type: 'UI' },
      { pin: 'UI9', label: 'UNIVERSAL INPUT 9', type: 'UI' },
      { pin: 'UI10', label: 'UNIVERSAL INPUT 10', type: 'UI' },
      { pin: 'UI11', label: 'UNIVERSAL INPUT 11', type: 'UI' },
      { pin: 'UI12', label: 'UNIVERSAL INPUT 12', type: 'UI' },
      { pin: 'UI13', label: 'UNIVERSAL INPUT 13', type: 'UI' },
      { pin: 'UI14', label: 'UNIVERSAL INPUT 14', type: 'UI' },
      { pin: 'UI15', label: 'UNIVERSAL INPUT 15', type: 'UI' },
      { pin: 'UI16', label: 'UNIVERSAL INPUT 16', type: 'UI' }
    ],
    description: 'FB16UI EXPANSION MODULE - 16 UNIVERSAL INPUTS'
  }
}

// Generate blank pin data for a controller + modules config
function generatePinLayout(controllerType, moduleSlots) {
  var ctrl = CONTROLLERS[controllerType]
  if (!ctrl) return null

  var pins = []

  // Controller outputs
  ctrl.outputs.forEach(function(o) {
    pins.push({
      section: 'CONTROLLER',
      sectionLabel: ctrl.name + ' - UNIVERSAL OUTPUT',
      pin: o.pin,
      pinType: o.type,
      com: '',
      system: '',
      pointDescription: 'SPARE',
      objectInstance: '',
      cableNumber: '',
      cableDescription: '',
      sensorMCC: '',
      linkedPointId: null
    })
  })

  // Controller inputs
  ctrl.inputs.forEach(function(i) {
    pins.push({
      section: 'CONTROLLER',
      sectionLabel: ctrl.name + ' - UNIVERSAL INPUT',
      pin: i.pin,
      pinType: i.type,
      com: '',
      system: '',
      pointDescription: 'SPARE',
      objectInstance: '',
      cableNumber: '',
      cableDescription: '',
      sensorMCC: '',
      linkedPointId: null
    })
  })

  // Module pins — ONE heading per physical module (outputs then inputs together underneath),
  // not split into separate OUTPUT/INPUT sections. A neat, at-a-glance "which module is this
  // point on" view was the actual ask — splitting each module in two worked against that.
  if (moduleSlots && moduleSlots.length > 0) {
    moduleSlots.forEach(function(ms, slotIdx) {
      var mod = MODULES[ms.type]
      if (!mod) return
      var slotNum = slotIdx + 1
      var slotLabel = 'MODULE ' + slotNum + ' (' + mod.name + ')'

      mod.outputs.forEach(function(o) {
        pins.push({
          section: 'MODULE-' + slotNum,
          sectionLabel: slotLabel,
          pin: 'M' + slotNum + '-' + o.pin,
          pinType: o.type,
          com: '',
          system: '',
          pointDescription: 'SPARE',
          objectInstance: '',
          cableNumber: '',
          cableDescription: '',
          sensorMCC: '',
          linkedPointId: null
        })
      })

      mod.inputs.forEach(function(i) {
        pins.push({
          section: 'MODULE-' + slotNum,
          sectionLabel: slotLabel,
          pin: 'M' + slotNum + '-' + i.pin,
          pinType: i.type,
          com: '',
          system: '',
          pointDescription: 'SPARE',
          objectInstance: '',
          cableNumber: '',
          cableDescription: '',
          sensorMCC: '',
          linkedPointId: null
        })
      })
    })
  }

  return pins
}

export { CONTROLLERS, MODULES, generatePinLayout }
