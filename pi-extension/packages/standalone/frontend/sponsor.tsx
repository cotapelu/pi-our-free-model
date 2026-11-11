import * as React from 'react'
import { createPortal } from 'react-dom'
import { createSponsorUI } from '../../../../client/sponsor-ui.js'
import image from '../../../../client/sponsor-beichen-examples.jpg?inline'
import '../../../../client/sponsor.css'

export const { SponsorPage, SponsorNotice } = createSponsorUI(React, image, createPortal, 'desktop')
