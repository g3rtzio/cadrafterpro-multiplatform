import { TestBed } from '@angular/core/testing';
import { TemplateLibrary } from './template-library';

describe('TemplateLibrary', () => {
  let service: TemplateLibrary;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(TemplateLibrary);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });
});
