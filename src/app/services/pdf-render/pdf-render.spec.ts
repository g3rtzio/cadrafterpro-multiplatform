import { TestBed } from '@angular/core/testing';
import { PdfRender } from './pdf-render';

describe('PdfRender', () => {
  let service: PdfRender;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(PdfRender);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });
});
